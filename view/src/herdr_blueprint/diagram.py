"""Mermaid rendering. This is the only module that imports termaid."""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache

import termaid
import termaid.layout.placement as termaid_placement
import termaid.parser.flowchart as termaid_flowchart
from rich.cells import cell_len
from rich.text import Text
from termaid import render_rich
from termaid.renderer import themes as termaid_themes
from termaid.renderer.canvas import Canvas

from .themes import PALETTES, Palette

# From roomy to compact: (padding_x, padding_y, gap). The first one that fits wins.
_LAYOUTS = [(4, 2, 4), (2, 1, 3), (1, 0, 2)]
# A source can pick its layout itself, whatever fits: a `%% layout: compact` line (the swarm
# view's zoom). termaid ignores %% lines.
LAYOUT_NAMES = {"roomy": _LAYOUTS[0], "normal": _LAYOUTS[1], "compact": _LAYOUTS[2]}
_LAYOUT_LINE = re.compile(r"^\s*%% layout: (\w+)\s*$", re.MULTILINE)

# termaid gets slow fast: a 200-node tree takes ~9 s. Larger sources are shown as text.
MAX_DIAGRAM_CHARS = 10_000


class DiagramError(Exception):
    """termaid could not draw the source."""


def width_of(text: Text) -> int:
    """Terminal columns of the widest line (wide CJK characters count as 2)."""
    return max((cell_len(line) for line in text.plain.splitlines()), default=0)


def _register(palette: Palette) -> None:
    # termaid only takes theme names, so palettes go into its theme table.
    # This is an internal API; the termaid version is pinned in pyproject.toml.
    termaid_themes.THEMES[palette.theme_name] = termaid_themes.Theme(
        name=palette.theme_name,
        node=palette.node,
        edge=palette.edge,
        arrow=palette.arrow,
        subgraph=palette.muted,
        label=palette.foreground,
        edge_label=palette.edge_label,
        subgraph_label=f"bold {palette.secondary}",
    )


for _palette in PALETTES.values():
    _register(_palette)


_cell_pairs = Canvas.to_styled_pairs


def _char_pairs(canvas: Canvas) -> list[list[tuple[str, str]]]:
    # termaid puts an empty shadow cell after each wide (CJK) character, joins
    # the characters without it, then styles by cell index, so every style after
    # a wide character lands one letter late. Dropping the shadow cells keeps
    # one (char, style) pair per character. Only termaid's Rich output calls this.
    return [[(ch, key) for ch, key in row if ch != ""] for row in _cell_pairs(canvas)]


Canvas.to_styled_pairs = _char_pairs

# Flowcharts whose author placed each box: (column, row) per node id, by the diagram's source.
_PLACED: dict[str, dict[str, tuple[int, int]]] = {}
_PLACED_KEPT = 32


def place(source: str, positions: dict[str, tuple[int, int]]) -> None:
    """Draw the flowchart `source` with each box in the grid column and row given for its id,
    instead of where termaid's layering would put it (rows in each column are packed from the
    top there, so a chain drifts away from the box it starts from). Edges are routed as usual."""
    _PLACED[source.strip()] = positions
    while len(_PLACED) > _PLACED_KEPT:
        del _PLACED[next(iter(_PLACED))]


_parse_flowchart = termaid_flowchart.parse_flowchart


def _parse_placed(text: str):
    # termaid's architecture diagrams carry grid positions; a placed flowchart borrows that path.
    graph = _parse_flowchart(text)
    positions = _PLACED.get(text.strip())
    if positions and all(node in positions for node in graph.node_order):
        graph.grid_positions = dict(positions)
        graph.placed_rows = True
    return graph


# termaid.parse (which drawing uses) and point.py both parse through these names.
termaid.parse_flowchart = _parse_placed
termaid_flowchart.parse_flowchart = _parse_placed
_place_nodes = termaid_placement.place_nodes


def _place_rows(graph, layout, layer_order, direction, gap_expansions=None) -> None:
    """termaid's placement, with the rows a placed flowchart asked for (left to right only)."""
    if not getattr(graph, "placed_rows", False) or not direction.is_horizontal:
        _place_nodes(graph, layout, layer_order, direction, gap_expansions)
        return
    from termaid.layout.layers import compute_gap_expansions

    # Room between columns for edges that cross rows, as termaid's own layering gets.
    expansions = compute_gap_expansions(graph, layer_order)
    extra = 0
    for layer, nodes in enumerate(layer_order):
        if layer > 0:
            extra += expansions.get(layer - 1, 0)
        for node in nodes:
            row = graph.grid_positions[node][1]
            cell = termaid_placement.GridCoord(col=layer * termaid_placement.STRIDE + 1 + extra, row=row * termaid_placement.STRIDE + 1)
            layout.placements[node] = termaid_placement.NodePlacement(node_id=node, grid=cell)
            for dc in range(-1, 2):
                for dr in range(-1, 2):
                    layout.grid_occupied[(cell.col + dc, cell.row + dr)] = node


termaid_placement.place_nodes = _place_rows


@dataclass(frozen=True)
class Drawing:
    """A drawn diagram and the layout (padding_x, padding_y, gap) it was drawn with."""

    text: Text
    padding: tuple[int, int, int]


@lru_cache(maxsize=64)
def _render(source: str, theme_name: str, max_width: int | None) -> Drawing:
    # Cached because a diagram is redrawn on mount, theme change and resize.
    # Callers must not modify the returned Text.
    text = Text()
    named = _LAYOUT_LINE.search(source)
    layouts = [LAYOUT_NAMES[named.group(1)]] if named and named.group(1) in LAYOUT_NAMES else _LAYOUTS
    layout = layouts[0]
    for layout in layouts:
        padding_x, padding_y, gap = layout
        try:
            text = render_rich(
                source,
                theme=theme_name,
                padding_x=padding_x,
                padding_y=padding_y,
                gap=gap,
            )
        except Exception as exc:  # termaid raises plain exceptions on bad input
            raise DiagramError(str(exc) or type(exc).__name__) from exc
        if max_width is None or width_of(text) <= max_width:
            break
    if not text.plain.strip():
        raise DiagramError("termaid returned no output")
    return Drawing(text, layout)


def render_diagram(source: str, palette: Palette, max_width: int | None = None) -> Text:
    """Draw Mermaid source as styled text that fits `max_width` when possible."""
    return draw_diagram(source, palette, max_width).text


def draw_diagram(source: str, palette: Palette, max_width: int | None = None) -> Drawing:
    """Like render_diagram, and say which layout won (point mode needs it)."""
    if len(source) > MAX_DIAGRAM_CHARS:
        raise DiagramError(
            f"This diagram is too large to draw ({len(source):,} characters, "
            f"limit {MAX_DIAGRAM_CHARS:,})"
        )
    if palette.theme_name not in termaid_themes.THEMES:
        _register(palette)
    drawing = _render(source, palette.theme_name, max_width)
    _DRAWN[(source, palette.theme_name, max_width)] = drawing
    while len(_DRAWN) > _DRAWN_KEPT:
        del _DRAWN[next(iter(_DRAWN))]
    return drawing


# Drawings made lately, so a view can show one at once instead of a placeholder while it
# draws again (a live document that changed elsewhere redraws the same diagram).
_DRAWN: dict[tuple[str, str, int | None], Drawing] = {}
_DRAWN_KEPT = 64


def peek(source: str, palette: Palette, max_width: int | None = None) -> Drawing | None:
    """The drawing of `source` if it was drawn lately at this width and palette, without drawing it."""
    return _DRAWN.get((source, palette.theme_name, max_width))
