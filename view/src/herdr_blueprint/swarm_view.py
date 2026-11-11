"""Blueprint as a peer-mail hub's swarm view: what moves in the drawing, what a click shows,
and what a note to the hub says.

The document comes from sources/swarm.py and is drawn like any other. A new version of it
replaces the old one in place (app.py), and everything that moves is drawn over the finished
drawing (an overlay on the fence, see document.py), so the layout never changes while it plays:

- a box whose agent changed state, status, tasks or mail pulses: reverse, then bright, then back;
- a task or step that got done flashes in the success colour;
- mail between the hub and an agent runs as a dot along the arrow joining them.

These play for a moment after a change; in between the drawing is not repainted at all, since
repainting it costs the UI time it needs for scrolling and clicks. What keeps moving while agents
work is a spinner in the header, a few cells that cost nothing to redraw.

Between changes, the boxes keep their state's colour: working agents and their next step in the
warning colour, finished ones and done tasks and steps in the success colour, offline agents in
the error colour, agents not started yet and tasks still waiting on others muted.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import lru_cache

from rich.cells import cell_len
from rich.style import Style
from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Markdown, Static

from .point import Box, _strip
from .sources.swarm import Agent, Document, Node, Snapshot, Task
from .themes import Palette

# Frames a second while something moves.
FPS = 15
SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
SPIN_SECONDS = 0.15
PULSE_SECONDS = 1.0
FLASH_SECONDS = 1.2
DOT_SECONDS = 0.8

_MERMAID = re.compile(r"^```mermaid\n(.*?)\n```", re.MULTILINE | re.DOTALL)


def mermaid_blocks(markdown: str) -> list[str]:
    """The Mermaid sources in a document, as its fences will hold them."""
    return [block.rstrip() for block in _MERMAID.findall(markdown)]


@dataclass(frozen=True)
class Geometry:
    """Where termaid put each box and each arrow, in drawing cells."""

    boxes: dict[str, Box]
    routes: dict[tuple[str, str], tuple[tuple[int, int], ...]]


@lru_cache(maxsize=16)
def geometry(code: str, padding: tuple[int, int, int]) -> Geometry:
    """The layout termaid draws `code` with at `padding` (left to right, so nothing is flipped)."""
    from termaid.layout.grid import compute_layout
    from termaid.parser.flowchart import parse_flowchart
    from termaid.routing.router import route_edges

    try:
        graph = parse_flowchart(_strip(code))
        layout = compute_layout(graph, *padding)
        routed = route_edges(graph, layout)
    except Exception:
        return Geometry({}, {})
    boxes = {node: Box(p.draw_x, p.draw_y, p.draw_width, p.draw_height) for node, p in layout.placements.items()}
    routes: dict[tuple[str, str], tuple[tuple[int, int], ...]] = {}
    for route in routed:
        cells: list[tuple[int, int]] = []
        points = list(route.draw_path)
        for (x1, y1), (x2, y2) in zip(points, points[1:]):
            dx, dy = (x2 > x1) - (x2 < x1), (y2 > y1) - (y2 < y1)
            x, y = x1, y1
            while (x, y) != (x2, y2):
                cells.append((x, y))
                x, y = x + dx, y + dy
        if points:
            cells.append(points[-1])
        routes[(route.edge.source, route.edge.target)] = tuple(dict.fromkeys(cells))
    return Geometry(boxes, routes)


def node_at(doc: Document, geo: Geometry, x: int, y: int) -> str | None:
    """The innermost box under a cell: a step before the task around it."""
    hits = [(box.width * box.height, node) for node, box in geo.boxes.items() if node in doc.nodes and box.contains(x, y)]
    return min(hits)[1] if hits else None


def _paint(text: Text, styles: list[tuple[Box, Style]], glyphs: list[tuple[int, int, str, Style]]) -> Text:
    """A copy of `text` with `styles` over boxes of cells and single characters replaced at cells
    (x, y). One pass over the lines: this runs for every frame of an animation, on the UI's thread."""
    lines = text.split("\n", allow_blank=True)
    columns: dict[int, list[int]] = {}  # row -> the character index starting at each cell

    def starts(y: int) -> list[int]:
        if y not in columns:
            cells: list[int] = []
            for index, ch in enumerate(lines[y].plain):
                cells.extend([index] * max(1, cell_len(ch)))
            columns[y] = cells
        return columns[y]

    for box, style in styles:
        for y in range(max(0, box.y), min(len(lines), box.y + box.height)):
            cells = starts(y)
            if box.x >= len(cells):
                continue
            end = box.x + box.width
            lines[y].stylize(style, cells[box.x], cells[end] if end < len(cells) else len(lines[y].plain))
    for x, y, ch, style in glyphs:
        if 0 <= y < len(lines) and x < len(starts(y)):
            index = starts(y)[x]
            line = lines[y]
            lines[y] = Text.assemble(line[:index], Text(ch, style), line[index + 1 :])
            columns.pop(y)  # the line changed; a wide character may have become a narrow one
    return Text("\n").join(lines)


@dataclass
class Motion:
    """What changed when in the swarm, so the drawing can show it."""

    snapshot: Snapshot | None = None
    doc: Document | None = None
    changed: dict[str, float] = field(default_factory=dict)  # agent name -> when its box last changed
    done_at: dict[tuple[str, int], float] = field(default_factory=dict)  # (task id, step or -1) -> when it got done
    dots: list[tuple[str, bool, float]] = field(default_factory=list)  # (agent, toward the hub, when sent)
    seen: set[str] = field(default_factory=set)
    primed: bool = False
    revision: int = 0  # counts snapshots taken: a frame can only differ after one, or while moving

    def update(self, snapshot: Snapshot | None, doc: Document | None, now: float) -> None:
        """Take a new snapshot. The first one only sets the scene: nothing animates for it."""
        previous = self.snapshot
        if snapshot is not None and previous is not None:
            before = {agent.name: agent for agent in previous.agents}
            for agent in snapshot.agents:
                old = before.get(agent.name)
                if old is None or (old.state, old.status, old.unread, old.tasks) != (agent.state, agent.status, agent.unread, agent.tasks):
                    self.changed[agent.name] = now
            old_tasks = {task.id: task for task in previous.tasks}
            for task in snapshot.tasks:
                old_task = old_tasks.get(task.id)
                if old_task is None:
                    continue
                if task.complete and not old_task.complete:
                    self.done_at[(task.id, -1)] = now
                for index, step in enumerate(task.steps):
                    if step.done and not (index < len(old_task.steps) and old_task.steps[index].done):
                        self.done_at[(task.id, index)] = now
        if snapshot is not None:
            for message_id, sender, recipient in snapshot.mail:
                if message_id in self.seen:
                    continue
                self.seen.add(message_id)
                if self.primed:
                    inbound = recipient == snapshot.hub
                    self.dots.append((sender if inbound else recipient, inbound, now))
            self.primed = True
        self.snapshot, self.doc = snapshot, doc
        self.revision += 1

    def overlay(self, code: str, padding: tuple[int, int, int], palette: Palette, now: float):
        """(signature, overlay) for the drawing of `code` now. Equal signatures draw the same."""
        snapshot, doc = self.snapshot, self.doc
        if snapshot is None or doc is None:
            return None, None
        geo = geometry(code, padding)
        node_of = {(node.kind, node.agent, node.task, node.step): node_id for node_id, node in doc.nodes.items()}
        styles: list[tuple[Box, Style]] = []
        glyphs: list[tuple[int, int, str, Style]] = []

        def paint(node_id: str | None, style: Style) -> None:
            box = geo.boxes.get(node_id or "")
            if box is not None:
                styles.append((box, style))

        paint("hub", Style(color=palette.accent, bold=True))
        state_colour = {"working": palette.warning, "finished": palette.success, "offline": palette.error, "not started": palette.muted}
        done = {task.id for task in snapshot.tasks if task.complete}
        for agent in snapshot.agents:
            node_id = node_of.get(("agent", agent.name, "", -1))
            if agent.state in state_colour:
                paint(node_id, Style(color=state_colour[agent.state]))
            age = now - self.changed.get(agent.name, float("-inf"))
            if age < 0.3:
                paint(node_id, Style(reverse=True))
            elif age < PULSE_SECONDS:
                paint(node_id, Style(color=palette.accent, bold=True))
            self._paint_tasks(agent, agent.tasks, node_of, done, paint, palette, now)
        self._paint_tasks(None, snapshot.hub_tasks, node_of, done, paint, palette, now)
        keep: list[tuple[str, bool, float]] = []
        for agent_name, inbound, start in self.dots:
            age = now - start
            if age >= DOT_SECONDS:
                continue
            keep.append((agent_name, inbound, start))
            route = list(geo.routes.get(("hub", node_of.get(("agent", agent_name, "", -1), "")), ()))
            if inbound:
                route.reverse()
            if not route:
                continue
            head = min(len(route) - 1, int(age / DOT_SECONDS * len(route)))
            for back, (ch, style) in enumerate([("●", Style(color=palette.accent, bold=True)), ("•", Style(color=palette.accent))]):
                if head - back >= 0:
                    x, y = route[head - back]
                    glyphs.append((x, y, ch, style))
        self.dots = keep
        signature = (palette.theme_name, tuple(styles), tuple(glyphs))

        def overlay(text: Text) -> Text:
            return _paint(text, styles, glyphs)

        return signature, overlay

    def _paint_tasks(self, agent: Agent | None, tasks, node_of, done, paint, palette: Palette, now: float) -> None:
        owner = agent.name if agent else ""
        working = agent is not None and agent.state == "working"
        for task in tasks:
            node_id = node_of.get(("task", owner, task.id, -1))
            flash = now - self.done_at.get((task.id, -1), float("-inf")) < FLASH_SECONDS
            if task.complete:
                paint(node_id, Style(color=palette.success, bold=flash, reverse=flash))
            elif any(before not in done for before in task.after):
                paint(node_id, Style(color=palette.muted))
            upcoming = next((i for i, step in enumerate(task.steps) if not step.done), None)
            for index, step in enumerate(task.steps):
                step_id = node_of.get(("step", owner, task.id, index))
                flash = now - self.done_at.get((task.id, index), float("-inf")) < FLASH_SECONDS
                if step.done:
                    paint(step_id, Style(color=palette.success, bold=flash, reverse=flash))
                elif index == upcoming and working:
                    paint(step_id, Style(color=palette.warning, bold=True))

    def moving(self, now: float) -> bool:
        """Whether a frame now can differ from the last one."""
        snapshot = self.snapshot
        if snapshot is None:
            return False
        if self.dots:
            return True
        if any(now - at < PULSE_SECONDS for at in self.changed.values()):
            return True
        return any(now - at < FLASH_SECONDS for at in self.done_at.values())

    def spinner(self, now: float) -> str:
        """The header's spinner while agents work ("⠙ 2 working"), else empty."""
        snapshot = self.snapshot
        working = sum(agent.state == "working" for agent in snapshot.agents) if snapshot else 0
        return f"{SPINNER[int(now / SPIN_SECONDS) % len(SPINNER)]} {working} working" if working else ""


# --- details: what a click on a box shows -------------------------------------------------------


def _fenced(text: str) -> str:
    longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
    fence = "`" * max(3, longest + 1)
    return f"{fence}text\n{text.rstrip()}\n{fence}"


def _task_lines(task: Task) -> list[str]:
    upcoming = next((i for i, step in enumerate(task.steps) if not step.done), None)
    lines = []
    for index, step in enumerate(task.steps):
        mark = "✓" if step.done else "▸" if index == upcoming else "·"
        code = f" · `{step.code}`" if step.code else ""
        lines.append(f"- {mark} {step.title}{code}")
    return lines or ["- no steps yet: its agent expands it when it starts"]


def _agent_of(snapshot: Snapshot, name: str) -> Agent | None:
    return next((agent for agent in snapshot.agents if agent.name == name), None)


def _task_of(snapshot: Snapshot, task_id: str) -> Task | None:
    return next((task for task in snapshot.tasks if task.id == task_id), None)


def details(snapshot: Snapshot, node: Node) -> str:
    """What a box stands for, as Markdown: its state, its steps, and the hub's brief behind it."""
    if node.kind == "hub":
        tasks = "\n".join(f"- {'✓' if t.complete else '○'} **{t.id}** {t.title}" for t in snapshot.hub_tasks) or "- none"
        agents = "\n".join(f"- **{a.name}** · {a.state}" + (f" · {a.status}" if a.status else "") for a in snapshot.agents) or "- none yet"
        return f"# {snapshot.hub} · hub\n\nSwarm {snapshot.label}.\n\n## Agents\n\n{agents}\n\n## Tasks the hub keeps\n\n{tasks}\n"
    agent = _agent_of(snapshot, node.agent) if node.agent else None
    brief = (
        f"## Brief from {snapshot.hub} to {agent.name}\n\n{_fenced(agent.brief)}\n"
        if agent is not None and agent.brief
        else f"## Brief\n\nNo brief: {'the hub keeps this task' if not node.agent else f'{node.agent} was not spawned with one'}.\n"
    )
    if node.kind in ("task", "step"):
        task = _task_of(snapshot, node.task)
        if task is None:
            return "# Gone\n\nThis task is no longer in the plan.\n"
        owner = f"{agent.name} ({agent.state})" if agent else "the hub"
        waits = f" · waits for {', '.join(task.after)}" if task.after else ""
        progress = "done" if task.complete else f"{sum(s.done for s in task.steps)}/{len(task.steps)} steps" if task.steps else "not expanded yet"
        clicked = ""
        if node.kind == "step" and 0 <= node.step < len(task.steps):
            step = task.steps[node.step]
            code = f" · `{step.code}`" if step.code else ""
            clicked = f"**Step** {step.title}{code} · {'done' if step.done else 'to do'}\n\n"
        return f"# {task.id} · {task.title}\n\n**Owner** {owner}{waits} · **{progress}**\n\n{clicked}## Steps\n\n" + "\n".join(_task_lines(task)) + f"\n\n{brief}"
    if agent is None:
        return "# Gone\n\nThis agent is no longer in the swarm.\n"
    facts = [f"**State** {agent.state}"]
    if agent.model:
        facts.append(f"**Model** {agent.model}")
    if agent.unread:
        facts.append(f"**Mail waiting** {agent.unread}")
    lines = [f"# {agent.name}", "", " · ".join(facts), ""]
    if agent.status:
        lines += [f"**Status** {agent.status}", ""]
    if agent.now:
        lines += [f"**Now** {agent.now}", ""]
    lines.append("## Tasks")
    lines.append("")
    for task in agent.tasks:
        lines.append(f"- {'✓' if task.complete else '○'} **{task.id}** {task.title}")
    if not agent.tasks:
        lines.append("- none")
    return "\n".join(lines) + f"\n\n{brief}"


class SwarmDetail(ModalScreen[None]):
    """What a box in the swarm view stands for, with the brief behind it."""

    BINDINGS = [
        Binding("escape", "dismiss_detail", "Close"),
        Binding("q", "dismiss_detail", show=False),
        Binding("j", "scroll(1)", show=False),
        Binding("k", "scroll(-1)", show=False),
    ]

    def __init__(self, markdown: str) -> None:
        super().__init__()
        self.markdown = markdown

    def compose(self) -> ComposeResult:
        with VerticalScroll(id="detail"):
            yield Markdown(self.markdown)
        yield Static("j/k scroll   esc close", id="detail-hint")

    def action_scroll(self, step: int) -> None:
        self.query_one("#detail", VerticalScroll).scroll_relative(y=step * 3, animate=False)

    def action_dismiss_detail(self) -> None:
        self.dismiss(None)

    def on_click(self, event) -> None:
        # A click outside the panel closes it.
        if event.widget is self:
            self.dismiss(None)


# --- notes: what the hub gets when the user points at a box ---------------------------------------


def note_prompt(snapshot: Snapshot | None, node: Node | None, described: str, note: str) -> str:
    """The note the hub gets: what the user pointed at in its swarm view, and their words."""
    if snapshot is None or node is None or node.kind == "hub":
        where = "the swarm as a whole" if node is not None and node.kind == "hub" else described
        return f"In the swarm view I pointed at {where}.\n{note}\n"
    agent = _agent_of(snapshot, node.agent) if node.agent else None
    if node.kind == "agent" and agent is not None:
        status = f"; status: {agent.status}" if agent.status else ""
        tasks = f"; tasks: {', '.join(t.id for t in agent.tasks)}" if agent.tasks else ""
        about = f'agent "{agent.name}" ({agent.state}{status}{tasks})'
    else:
        task = _task_of(snapshot, node.task)
        if task is None:
            about = described
        else:
            owner = f"owner {agent.name}" if agent else "kept by you"
            progress = "done" if task.complete else f"{sum(s.done for s in task.steps)}/{len(task.steps)} steps" if task.steps else "not expanded"
            step = f', step "{task.steps[node.step].title}"' if node.kind == "step" and 0 <= node.step < len(task.steps) else ""
            about = f'task {task.id} "{task.title}" ({owner}; {progress}){step}'
    relay = f" Act on it, or pass it on to {agent.name} with peer_send user_quote." if agent is not None else ""
    return f"In the swarm view I pointed at {about}.{relay}\n{note}\n"
