"""Views for documents and diagrams. Mermaid is drawn with the active palette.

Drawing happens only when the worker asks for it (the draw flag). termaid can
take seconds on a big diagram, so it runs in a thread behind a placeholder.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Callable
from functools import partial

from rich.text import Text
from rich.style import Style
from textual import events
from textual.app import App
from textual.content import Content
from textual.message import Message
from textual.widgets import Log, Markdown, Static
from textual.widgets.markdown import MarkdownFence
from textual.worker import get_current_worker

from .diagram import DiagramError, Drawing, draw_diagram, peek, render_diagram
from .point import Part, highlight
from .themes import palette_for_theme

PLACEHOLDER = "Drawing diagram…"


def painted(app: App, drawing: Drawing, shown: Part | None, marked: Part | None, overlay: Overlay | None = None) -> Text:
    """The drawing with `overlay` (colours and marks a live document adds) under the part a
    note was sent about in the warning colour, and the selected part in reverse video on top."""
    text = overlay(drawing.text) if overlay is not None else drawing.text
    if marked is not None:
        text = highlight(text, marked, Style(color=palette_for_theme(app.theme).warning, bold=True))
    if shown is not None:
        text = highlight(text, shown, Style(reverse=True))
    return text


# Turns a drawing into the same drawing with colours or marks added; it must not change its layout.
Overlay = Callable[[Text], Text]


def as_code(source: str) -> str:
    """Mermaid source as a fenced code block, shown as-is without drawing."""
    longest = max((len(run) for run in re.findall(r"`+", source)), default=0)
    fence = "`" * max(3, longest + 1)
    return f"{fence}mermaid\n{source}\n{fence}\n"


def draw(app: App, source: str, max_width: int | None = None) -> Content:
    """Mermaid source as themed content, or an error notice followed by the source."""
    try:
        return Content.from_rich_text(render_diagram(source, palette_for_theme(app.theme), max_width))
    except DiagramError as exc:
        return failed(app, source, exc)


def failed(app: App, source: str, exc: DiagramError) -> Content:
    """The error notice and the source, for a diagram termaid could not draw."""
    palette = palette_for_theme(app.theme)
    notice = Text(f"Could not draw this diagram: {exc}\n\n", style=f"bold {palette.error}")
    return Content.from_rich_text(notice + Text(source, style=palette.muted))


class DiagramFence(MarkdownFence):
    """A fence that draws ```mermaid blocks and highlights all other code."""

    # Columns taken by the body padding and the fence padding around a diagram.
    FRAME_WIDTH = 10

    def __init__(self, markdown: Markdown, token, code: str) -> None:
        super().__init__(markdown, token, code)
        self._requested: tuple[str, int] | None = None
        # The last drawing shown, with its layout; None until drawn (or if it failed).
        self.drawing: Drawing | None = None
        # The part shown highlighted in point mode, and one a note was sent about.
        self.shown: Part | None = None
        self.marked: Part | None = None
        # Colours and marks over the drawing (a live document's animation).
        self.overlay: Overlay | None = None
        if self.is_mermaid:
            self._highlighted_code = Content(PLACEHOLDER)
            # Drawn lately (the same diagram in a document that changed elsewhere): show it at
            # once, so a new version doesn't flash the placeholder and jump the page.
            width = max(20, markdown.app.size.width - self.FRAME_WIDTH)
            drawn = peek(self.code, palette_for_theme(markdown.app.theme), width)
            if drawn is not None:
                self.drawing = drawn
                self._requested = (markdown.app.theme, width)
                self._highlighted_code = Content.from_rich_text(drawn.text)

    class Drawn(Message):
        """A new drawing is on screen (first draw, theme change)."""

        def __init__(self, fence: "DiagramFence") -> None:
            super().__init__()
            self.fence = fence

    @property
    def is_mermaid(self) -> bool:
        return (self.lexer or "").strip().lower() == "mermaid"

    def on_mount(self) -> None:
        if self.is_mermaid and self.drawing is not None:
            self.post_message(self.Drawn(self))  # drawn at once from the cache
        elif self.is_mermaid:
            self._redraw()

    def notify_style_update(self) -> None:
        if not self.is_mermaid:
            super().notify_style_update()
            return
        # Redraw with the new palette; skip MarkdownFence's syntax re-highlight.
        self._redraw()
        super(MarkdownFence, self).notify_style_update()

    def _redraw(self) -> None:
        width = max(20, self.app.size.width - self.FRAME_WIDTH)
        if self._requested == (self.app.theme, width):
            return
        self._requested = (self.app.theme, width)
        self.run_worker(partial(self._draw, width), thread=True, exclusive=True, group="draw")

    def _draw(self, width: int) -> None:
        try:
            drawing: Drawing | None = draw_diagram(self.code, palette_for_theme(self.app.theme), width)
            content = Content.from_rich_text(drawing.text)
        except DiagramError as exc:
            drawing, content = None, failed(self.app, self.code, exc)
        if not get_current_worker().is_cancelled:
            self.app.call_from_thread(self._show, drawing, content)

    def _show(self, drawing: Drawing | None, content: Content) -> None:
        self.drawing = drawing
        if drawing is not None and (self.shown or self.marked or self.overlay):
            # Redrawn (a theme change): keep the selection, the mark and the overlay.
            content = Content.from_rich_text(painted(self.app, drawing, self.shown, self.marked, self.overlay))
        self._highlighted_code = content
        self.set_content(content)
        self.post_message(self.Drawn(self))

    def show(self, part: Part | None) -> None:
        """Highlight `part` (None for none) in the current drawing."""
        self.shown = part
        self._repaint()

    def mark(self, part: Part | None) -> None:
        """Mark the part a note was sent about (None for none)."""
        self.marked = part
        self._repaint()

    def paint(self, overlay: Overlay | None) -> None:
        """Draw `overlay` over the drawing (None for none)."""
        self.overlay = overlay
        self._repaint()

    def _repaint(self) -> None:
        if self.drawing is not None:
            self._highlighted_code = Content.from_rich_text(painted(self.app, self.drawing, self.shown, self.marked, self.overlay))
            self.set_content(self._highlighted_code)


class DocumentView(Markdown):
    """Markdown. With draw_diagrams, Mermaid fences are drawn as diagrams."""

    def __init__(self, markdown: str, draw_diagrams: bool = False, **kwargs) -> None:
        self.draw_diagrams = draw_diagrams
        super().__init__(markdown, **kwargs)

    def get_block_class(self, block_name: str):
        if block_name == "fence" and self.draw_diagrams:
            return DiagramFence
        return super().get_block_class(block_name)

    async def patch(self, markdown: str) -> None:
        """Change to `markdown` remounting only the blocks whose source changed (a live document's
        new version): the rest of the page, its layout and the drawings in it stay as they are.
        A document whose blocks changed in kind or number is updated as a whole."""
        from markdown_it import MarkdownIt
        from textual.widgets._markdown import MarkdownBlock

        parser = MarkdownIt("gfm-like") if self._parser_factory is None else self._parser_factory()
        async with self.lock:
            tokens = await asyncio.get_running_loop().run_in_executor(None, parser.parse, markdown)
            new = list(self._parse_markdown(tokens))
            old = [child for child in self.children if isinstance(child, MarkdownBlock)]
            same_shape = len(new) == len(old) and all(type(a) is type(b) for a, b in zip(old, new))
            if same_shape:
                before, after = self.source.split("\n"), markdown.split("\n")

                def text(lines: list[str], block) -> str:
                    start, end = block.source_range
                    return "\n".join(lines[start:end])

                with self.app.batch_update():
                    for current, wanted in zip(old, new):
                        if text(before, current) == text(after, wanted):
                            current.source_range = wanted.source_range
                            continue
                        await self.mount(wanted, before=current)
                        await current.remove()
                self._markdown = markdown
                self._table_of_contents = None
        if not same_shape:
            await self.update(markdown)


class PlainView(Log):
    """Plain text for files too large to lay out as Markdown."""

    # Lines written per step; the event loop runs between steps.
    CHUNK_LINES = 1_000

    def __init__(self, **kwargs) -> None:
        super().__init__(highlight=False, auto_scroll=False, **kwargs)

    async def load(self, text: str) -> None:
        """Write text in steps so a 1 MB file never freezes the screen."""
        lines = text.split("\n")
        for start in range(0, len(lines), self.CHUNK_LINES):
            self.write_lines(lines[start : start + self.CHUNK_LINES], scroll_end=False)
            await asyncio.sleep(0)


class DiagramView(Static):
    """A single Mermaid diagram that redraws on theme change and resize."""

    def __init__(self, source: str, **kwargs) -> None:
        super().__init__(PLACEHOLDER, markup=False, **kwargs)
        self.source = source
        self._requested: tuple[str, int | None] | None = None
        # The last drawing shown, with its layout; None until drawn (or if it failed).
        self.drawing: Drawing | None = None
        # The part shown highlighted in point mode, and one a note was sent about.
        self.shown: Part | None = None
        self.marked: Part | None = None

    class Drawn(Message):
        """A new drawing is on screen (first draw, theme change, resize)."""

        def __init__(self, view: "DiagramView") -> None:
            super().__init__()
            self.view = view

    class Clicked(Message):
        """A click at a drawing cell."""

        def __init__(self, view: "DiagramView", x: int, y: int) -> None:
            super().__init__()
            self.view, self.x, self.y = view, x, y

    def show(self, part: Part | None) -> None:
        """Highlight `part` (None for none) in the current drawing."""
        self.shown = part
        if self.drawing is not None:
            self.update(Content.from_rich_text(painted(self.app, self.drawing, self.shown, self.marked)))

    def mark(self, part: Part | None) -> None:
        """Mark the part a note was sent about (None for none)."""
        self.marked = part
        if self.drawing is not None:
            self.update(Content.from_rich_text(painted(self.app, self.drawing, self.shown, self.marked)))

    def on_click(self, event: events.Click) -> None:
        offset = event.get_content_offset(self)
        if offset is not None:
            self.post_message(self.Clicked(self, offset.x, offset.y))

    def on_mount(self) -> None:
        self.watch(self.app, "theme", self._redraw, init=True)

    def on_resize(self) -> None:
        self._redraw()

    def _redraw(self, _theme: str | None = None) -> None:
        width = (self.parent.size.width if self.parent else 0) or None
        if self._requested == (self.app.theme, width):
            return
        self._requested = (self.app.theme, width)
        self.run_worker(partial(self._draw, width), thread=True, exclusive=True, group="draw")

    def _draw(self, width: int | None) -> None:
        try:
            drawing: Drawing | None = draw_diagram(self.source, palette_for_theme(self.app.theme), width)
            content = Content.from_rich_text(drawing.text)
        except DiagramError as exc:
            drawing, content = None, failed(self.app, self.source, exc)
        if not get_current_worker().is_cancelled:
            self.app.call_from_thread(self._show, drawing, content)

    def _show(self, drawing: Drawing | None, content: Content) -> None:
        self.drawing = drawing
        self.update(content)
        self.post_message(self.Drawn(self))
