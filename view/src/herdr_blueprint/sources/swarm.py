"""The swarm a peer-mail hub owns, as Blueprint shows it.

peer-mail (the omp extension one level up) keeps the swarm in files: members, the hub's plan,
each agent's steps, the briefs the hub gave, and the mail. This reads them and draws the hub,
its agents and their tasks as one Markdown document with a Mermaid diagram, the way an agent
would send it to Blueprint, but without an agent: nothing here costs tokens.

The hub opens Blueprint in a herdr pane beside it with PEER_MAIL_VIEW naming a record of which
hub (by pid) this view follows, and PEER_MAIL_DIR when the mailbox isn't the default one.
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path

from ..diagram import place
from ..item import Item

# How often the swarm's files are read.
POLL_SECONDS = 0.5
# A page change that leaves the diagram as it was (the table) goes up at most this often.
TABLE_SECONDS = 2.0
# A member on another machine silent for longer than this is offline (peer-mail's STALE_MS).
STALE_SECONDS = 15
# Box labels longer than this are cut: the side pane is about 100 columns wide.
LABEL_MAX = 28
CELL_MAX = 60
# Recent mail per member that is checked for new messages.
MAIL_WINDOW = 10
# Who the swarm view's document is from, in the header; also how the app tells it from sends.
SENT_BY = "peer-mail"


def mail_root() -> Path:
    return Path(os.environ.get("PEER_MAIL_DIR") or Path.home() / ".omp" / "peer-mail")


def _json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _files(folder: Path) -> list[Path]:
    try:
        return sorted(p for p in folder.iterdir() if p.suffix == ".json")
    except OSError:
        return []


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _online(peer: dict, now: float) -> bool:
    pid = peer.get("pid")
    if pid is None:
        return False
    if peer.get("host") == socket.gethostname():
        return _pid_alive(int(pid))
    return now - peer.get("seenAt", 0) / 1000 <= STALE_SECONDS


@dataclass(frozen=True)
class Step:
    """One step an agent drew its task out into (peer_steps)."""

    title: str
    done: bool
    id: str = ""
    after: str = ""  # the step it continues from; empty for the previous one (the task, for the first)
    code: str = ""  # the code it stands for, as path:line


@dataclass(frozen=True)
class Task:
    id: str
    title: str
    owner: str | None  # the agent doing it; None when the hub keeps it
    after: tuple[str, ...]
    steps: tuple[Step, ...]
    complete: bool  # the hub marked it done, or its agent finished all its steps


@dataclass(frozen=True)
class Agent:
    name: str
    state: str
    status: str = ""
    now: str = ""  # what it is doing now: its tool call's intent, or "thinking"
    model: str = ""
    unread: int = 0
    tasks: tuple[Task, ...] = ()
    brief: str = ""  # the prompt the hub spawned it with
    herdr: dict | None = None


@dataclass(frozen=True)
class Snapshot:
    label: str
    hub: str
    hub_tasks: tuple[Task, ...]
    agents: tuple[Agent, ...]
    # Recent mail between the hub and its agents: (id, from, to).
    mail: tuple[tuple[str, str, str], ...] = ()

    @property
    def tasks(self) -> tuple[Task, ...]:
        return self.hub_tasks + tuple(task for agent in self.agents for task in agent.tasks)


def _step(raw: dict, index: int) -> Step:
    # One token: a path never breaks the diagram's `%% code:` line.
    code = (str(raw.get("code") or "").split() or [""])[0]
    return Step(str(raw.get("title", "")), bool(raw.get("done")), str(raw.get("id") or f"s{index + 1}"), str(raw.get("after") or ""), code)


def _task(raw: dict, steps: list | None, owner: str | None) -> Task:
    shown = tuple(_step(s, i) for i, s in enumerate(steps or []) if isinstance(s, dict))
    done = bool(raw.get("done")) or (bool(shown) and all(s.done for s in shown))
    return Task(str(raw["id"]), str(raw.get("title", "")), owner, tuple(str(a) for a in raw.get("after") or []), shown, done)


def read_snapshot(root: Path, hub_pid: int, now: float) -> Snapshot | None:
    """The swarm as the hub with pid `hub_pid` sees it, or None when that hub isn't in it."""
    swarm = root / "swarm"
    phase = _json(swarm / "phase.json")
    if not isinstance(phase, dict):
        return None
    peers = [p for p in (_json(f) for f in _files(swarm / "peers")) if isinstance(p, dict) and p.get("phase") == phase.get("id")]
    hub = next((p for p in peers if p.get("hub") is None and p.get("pid") == hub_pid), None)
    if hub is None:
        return None
    hub_name = str(hub["name"])
    agents: dict[str, dict] = {}
    for peer in peers:
        if peer.get("hub") != hub_name:
            continue
        online = _online(peer, now)
        activity = peer.get("activity") or {}
        working = online and activity.get("state") not in (None, "idle")
        state = "offline" if not online else "finished" if peer.get("finished") else "working" if working else "idle"
        doing = ("thinking" if activity.get("state") == "thinking" else activity.get("intent") or activity.get("tool") or "") if working else ""
        brief = _json(swarm / "briefs" / f"{peer.get('spawn')}.json") if peer.get("spawn") else None
        agents[peer["name"]] = {
            "name": peer["name"], "state": state, "status": peer.get("status") or "", "now": doing,
            "model": peer.get("model") or "", "unread": len(_files(swarm / "inbox" / peer["name"])), "tasks": [],
            "brief": (brief or {}).get("prompt", "") if isinstance(brief, dict) else "", "herdr": peer.get("herdr"),
        }
    hub_tasks: list[Task] = []
    plan = _json(swarm / "plans" / f"{hub_name}.json")
    for raw in plan if isinstance(plan, list) else []:
        if not isinstance(raw, dict) or "id" not in raw:
            continue
        owner = raw.get("agent")
        if not owner or owner == hub_name:
            hub_tasks.append(_task(raw, None, None))
            continue
        if owner not in agents:
            agents[owner] = {"name": owner, "state": "not started", "tasks": []}
        steps = _json(swarm / "steps" / f"{owner}.json")
        agents[owner]["tasks"].append(_task(raw, steps.get(raw["id"]) if isinstance(steps, dict) else None, owner))
    mail: dict[str, tuple[str, str, str]] = {}
    for name in [hub_name, *agents]:
        for folder in (swarm / "delivered" / name, swarm / "inbox" / name):
            for path in _files(folder)[-MAIL_WINDOW:]:
                message = _json(path)
                if not isinstance(message, dict) or message.get("phase") != phase.get("id"):
                    continue
                ends = (message.get("from"), message.get("to"))
                if hub_name in ends and (ends[0] in agents or ends[1] in agents):
                    mail[message["id"]] = (message["id"], ends[0], ends[1])
    cards = tuple(Agent(**{**card, "tasks": tuple(card["tasks"])}) for card in agents.values())
    return Snapshot(str(phase.get("label", "swarm")), hub_name, tuple(hub_tasks), cards, tuple(mail.values()))


# --- the document -----------------------------------------------------------------------


@dataclass(frozen=True)
class Node:
    """What a box in the drawing stands for."""

    kind: str  # hub, agent, task, or step
    agent: str = ""
    task: str = ""
    step: int = -1


@dataclass
class Document:
    title: str
    markdown: str
    diagram: str
    # Mermaid node id -> what it stands for.
    nodes: dict[str, Node] = field(default_factory=dict)


def _label(text: str, limit: int = LABEL_MAX) -> str:
    """Text safe inside a quoted Mermaid label: one line, no quotes or markup, at most `limit` columns."""
    flat = " ".join(text.translate(str.maketrans({c: "'" for c in '"`<>[]{}()|#;'})).split())
    return flat if len(flat) <= limit else f"{flat[: limit - 1]}…"


def _cell(text: str) -> str:
    flat = " ".join(text.split()).replace("|", "\\|")
    return flat if len(flat) <= CELL_MAX else f"{flat[: CELL_MAX - 1]}…"


def agent_label(agent: Agent) -> str:
    # Plain text only: an emoji's width differs between terminals and termaid, which would bend the box.
    mail = f" · {agent.unread} mail" if agent.unread else ""
    return _label(f"{agent.name} · {agent.state}{mail}", LABEL_MAX + 8)


def task_label(task: Task) -> str:
    progress = f" · {sum(s.done for s in task.steps)}/{len(task.steps)}" if task.steps and not task.complete else ""
    return _label(f"{'✓ ' if task.complete else ''}{task.id}: {task.title}{progress}", LABEL_MAX + 8)


def step_label(task: Task, index: int) -> str:
    step = task.steps[index]
    upcoming = next((i for i, s in enumerate(task.steps) if not s.done), None)
    mark = "✓ " if step.done else "▸ " if index == upcoming else ""
    return _label(f"{mark}{step.title}")


def document(snapshot: Snapshot) -> Document:
    """The hub, its agents and their tasks as Markdown: a summary, the diagram and a table.

    The hub draws the first part, left to right: itself, its agents, and the tasks it gave each
    (peer_plan). Each agent goes on from its task's box, also left to right: the steps it drew
    the task out into (peer_steps), each from the step it continues, tied to code with `%% code:`
    lines like any Blueprint diagram. Tasks the hub keeps hang off the hub itself. Node ids are
    positions, so no member, task or step name can break the diagram's syntax.
    """
    nodes: dict[str, Node] = {"hub": Node("hub")}
    lines = ["flowchart LR", f'  hub["{_label(f"{snapshot.hub} · hub")}"]']
    codes: list[str] = []
    ids: dict[str, str] = {}  # task id -> node id
    tasks: list[tuple[str, Task]] = []
    for index, agent in enumerate(snapshot.agents):
        node = f"a{index}"
        nodes[node] = Node("agent", agent=agent.name)
        lines.append(f'  {node}["{agent_label(agent)}"]')
        lines.append(f"  hub --> {node}")
        for task in agent.tasks:
            tasks.append((node, task))
    tasks.extend(("hub", task) for task in snapshot.hub_tasks)
    for position, (_owner, task) in enumerate(tasks):
        ids.setdefault(task.id, f"t{position}")
    # Where each box goes, as (column, row): the hub, then each agent in the row of its first
    # task, the tasks it owns one under the other, and each task's steps going on to the right
    # in the task's row; a step that branches off takes the next row of the task's block. Tasks
    # the hub keeps come last, in the tasks' column.
    positions: dict[str, tuple[int, int]] = {"hub": (0, 0)}
    taken: set[tuple[int, int]] = set()
    next_row = 0
    owners = [(f"a{index}", agent.tasks) for index, agent in enumerate(snapshot.agents)] + [("hub", snapshot.hub_tasks)]
    for owner, owned in owners:
        if owner != "hub":
            positions[owner] = (1, next_row)
            if not owned:
                next_row += 1
        for task in owned:
            node = ids[task.id]
            nodes[node] = Node("task", agent=task.owner or "", task=task.id)
            lines.append(f'  {node}["{task_label(task)}"]')
            lines.append(f"  {owner} {'-.->' if owner == 'hub' else '-->'} {node}")
            positions[node] = (2, next_row)
            taken.add(positions[node])
            block_end = next_row + 1
            drawn: dict[str, str] = {}  # step id -> node id
            for index, step in enumerate(task.steps):
                step_node = f"{node}s{index}"
                nodes[step_node] = Node("step", agent=task.owner or "", task=task.id, step=index)
                lines.append(f'  {step_node}["{step_label(task, index)}"]')
                parent = (drawn.get(step.after) if step.after else None) or (f"{node}s{index - 1}" if index else node)
                lines.append(f"  {parent} --> {step_node}")
                column, row = positions[parent][0] + 1, positions[parent][1]
                if (column, row) in taken:
                    row, block_end = block_end, block_end + 1
                positions[step_node] = (column, row)
                taken.add(positions[step_node])
                drawn.setdefault(step.id, step_node)
                if step.code:
                    codes.append(f"  %% code: {step_node} {step.code}")
            next_row = block_end
    for _owner, task in tasks:
        for before in task.after:
            if before in ids:
                lines.append(f"  {ids[before]} --> {ids[task.id]}")
    if codes:
        lines += ["  %% Blueprint: the code each box stands for (not drawn)", *codes]
    diagram = "\n".join(lines)
    place(diagram, positions)

    counts: dict[str, int] = {}
    for agent in snapshot.agents:
        counts[agent.state] = counts.get(agent.state, 0) + 1
    summary = ", ".join(f"{count} {state}" for state, count in counts.items())
    all_tasks = snapshot.tasks
    done = sum(task.complete for task in all_tasks)
    agents = f"{len(snapshot.agents)} agents ({summary})" if snapshot.agents else "no agents yet"
    plan = f"Plan: {done}/{len(all_tasks)} tasks done." if all_tasks else "No plan set."
    table = [
        "| Agent | State | Status | Now | Model | Mail |",
        "|---|---|---|---|---|---|",
        *(
            f"| {_cell(a.name)} | {a.state} | {_cell(a.status)} | {_cell(a.now)} | {_cell(a.model.split('/')[-1])} | {a.unread or ''} |"
            for a in snapshot.agents
        ),
    ]
    markdown = "\n".join([
        f"# Swarm {snapshot.label}",
        "",
        f"Hub {snapshot.hub}: {agents}. {plan}",
        "",
        "```mermaid",
        diagram,
        "```",
        "",
        *(table if snapshot.agents else []),
    ])
    return Document(f"Swarm {snapshot.label}", markdown, diagram, nodes)


# --- following the hub -------------------------------------------------------------------


def read_record(path: Path) -> dict | None:
    record = _json(path)
    return record if isinstance(record, dict) else None


async def watch_swarm(record_path: Path, own_pane: str | None) -> AsyncIterator[tuple[Snapshot | None, Document | None, Item | None]]:
    """Each change of the swarm: its snapshot, its document, and an Item when the document changed.

    Ends when the hub opened its view in another pane (the record names that pane now).
    """
    import time

    root = mail_root()
    last_markdown: str | None = None
    last_diagram: str | None = None
    last_snapshot: Snapshot | None = None
    doc: Document | None = None
    markdown = ""
    shown_at = 0.0
    while True:
        record = read_record(record_path)
        if record and own_pane and record.get("pane") not in (None, own_pane):
            return
        now = time.time()
        snapshot = read_snapshot(root, int(record["hubPid"]), now) if record and record.get("hubPid") else None
        changed = snapshot != last_snapshot or last_markdown is None
        if changed:
            last_snapshot = snapshot
            doc = document(snapshot) if snapshot else None
            markdown = doc.markdown if doc else "# Swarm\n\nWaiting for the hub to join the swarm…\n"
        item = None
        diagram = doc.diagram if doc else ""
        # A new diagram goes up at once. The rest of the page (the table's Now column changes with
        # every tool call an agent makes) at most every TABLE_SECONDS: each new version rebuilds the
        # page, which costs the UI time it needs for scrolling and clicks.
        if markdown != last_markdown and (diagram != last_diagram or now - shown_at >= TABLE_SECONDS):
            last_markdown, last_diagram, shown_at = markdown, diagram, now
            title = doc.title if doc else "Swarm"
            item = Item(kind="markdown", title=title, source=markdown, sent_by=SENT_BY, at=now, draw=True)
        if changed or item is not None:
            yield snapshot, doc, item
        await asyncio.sleep(POLL_SECONDS)
