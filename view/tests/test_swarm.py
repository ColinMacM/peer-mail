"""The swarm view: a peer-mail hub's swarm, read from peer-mail's files and drawn live."""

import json
import os
import socket
import time
from pathlib import Path

import pytest
from textual import events

from herdr_blueprint import swarm_view
from herdr_blueprint.app import BlueprintApp, NoteLine
from herdr_blueprint.document import PLACEHOLDER, DiagramFence, DocumentView
from herdr_blueprint.sources import swarm
from herdr_blueprint.sources.pane import Source
from herdr_blueprint.themes import get_palette


def write(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


def peer(name: str, hub: str | None, **extra) -> dict:
    return {"name": name, "phase": "p1", "pid": os.getpid(), "host": socket.gethostname(), "cwd": "/tmp", "joinedAt": 0, "seenAt": 0, "hub": hub, **extra}


@pytest.fixture
def mailbox(tmp_path, monkeypatch) -> Path:
    """A swarm: hub `lead` (this process), a finished writer, a working tester, a plan with steps and a brief."""
    root = tmp_path / "peer-mail"
    monkeypatch.setenv("PEER_MAIL_DIR", str(root))
    box = root / "swarms" / "run"
    write(box / "phase.json", {"id": "p1", "label": "run"})
    write(box / "peers/lead.json", peer("lead", None))
    write(box / "peers/writer.json", peer("writer", "lead", spawn="s1", finished=True, status="done"))
    write(box / "peers/tester.json", peer("tester", "lead", spawn="s2", activity={"state": "running", "tool": "bash", "intent": "Run tests"}))
    write(box / "briefs/s1.json", {"prompt": "Write a.txt containing alpha.\nNothing else.", "tasks": ["t1"]})
    write(box / "plans/lead.json", [
        {"id": "t1", "title": "write", "agent": "writer"},
        {"id": "t2", "title": "test", "agent": "tester", "after": ["t1"]},
        {"id": "t3", "title": "bench", "agent": "bencher"},
        {"id": "t4", "title": "merge", "agent": "lead", "after": ["t2"]},
    ])
    write(box / "steps/writer.json", {"t1": [{"title": "write it", "done": True}]})
    write(box / "steps/tester.json", {"t2": [
        {"id": "s1", "title": "unit", "done": True, "code": "src/arm.rs:40"},
        {"id": "s2", "title": "rig"},
        {"id": "s3", "title": "report", "after": "s1"},
    ]})
    write(root / "views/rec.json", {"pane": "none", "hubPid": os.getpid()})
    return root


def test_the_plan_hangs_on_its_agents_and_the_hub_keeps_its_own_tasks(mailbox):
    snapshot = swarm.read_snapshot(mailbox, os.getpid(), 0)
    assert snapshot is not None
    assert [t.id for t in snapshot.hub_tasks] == ["t4"]
    assert [(a.name, a.state, [t.id for t in a.tasks]) for a in snapshot.agents] == [
        ("tester", "working", ["t2"]),
        ("writer", "finished", ["t1"]),
        ("bencher", "not started", ["t3"]),
    ]
    doc = swarm.document(snapshot)
    lines = doc.diagram.splitlines()
    # The hub's own task hangs off the hub, not off a made-up agent called "lead".
    assert not any('"lead · not started"' in line for line in lines)
    hub_task = next(node for node, n in doc.nodes.items() if n.kind == "task" and n.task == "t4")
    assert f"  hub -.-> {hub_task}" in lines
    # Each agent goes on from its task's box, left to right: its steps, each from the one it continues.
    t2 = next(node for node, n in doc.nodes.items() if n.kind == "task" and n.task == "t2")
    assert f'  {t2}["t2: test · 1/3"]' in lines
    assert f"  {t2} --> {t2}s0" in lines and f"  {t2}s0 --> {t2}s1" in lines
    assert f"  {t2}s0 --> {t2}s2" in lines  # s3 branches from s1
    assert f'  {t2}s1["▸ rig"]' in lines
    assert f"  %% code: {t2}s0 src/arm.rs:40" in lines
    assert any('"✓ t1: write"' in line for line in lines)
    # Another hub's pid sees nothing.
    assert swarm.read_snapshot(mailbox, 2**22 + 7, 0) is None


def test_the_view_follows_its_hub_into_whichever_swarm_it_is_in(mailbox):
    # Another swarm, listed first, whose hub is another session.
    other = mailbox / "swarms" / "2.0.0"
    write(other / "phase.json", {"id": "p2", "label": "2.0.0"})
    write(other / "peers/hub.json", {**peer("hub", None), "phase": "p2", "pid": 2**22 + 7})
    assert swarm.read_snapshot(mailbox, os.getpid(), 0).hub == "lead"
    assert swarm.read_snapshot(mailbox, 2**22 + 7, 0).label == "2.0.0"


def test_names_cannot_break_the_diagram():
    task = swarm.Task("t1", 'fix [arm] "now"', None, (), (), False)
    agent = swarm.Agent('x"]; click', "idle", tasks=(task,))
    doc = swarm.document(swarm.Snapshot("run", "lead", (), (agent,)))
    assert '  a0["x\'\'\' click · idle"]' in doc.diagram.splitlines()
    assert "'arm' 'now'" in doc.diagram


def test_a_big_swarm_folds_its_oldest_finished_work_to_stay_drawable():
    from herdr_blueprint.diagram import draw_diagram

    def task(order: int, owner: str, done: bool, steps: int, done_steps: int) -> swarm.Task:
        drawn = tuple(swarm.Step(f"step {i} of task {order}", i < done_steps, f"s{i}", code=f"src/m{order}.rs:{i}") for i in range(steps))
        return swarm.Task(f"t{order}", f"task number {order}", owner, (f"t{order - 1}",) if order else (), drawn, done, order)

    # Eight agents with three tasks each, oldest first: the first five finished all theirs.
    agents = []
    for a in range(8):
        finished = a < 5
        tasks = tuple(task(a * 3 + i, f"agent{a}", finished, 8, 8 if finished else 3) for i in range(3))
        agents.append(swarm.Agent(f"agent{a}", "finished" if finished else "working", tasks=tasks))
    snapshot = swarm.Snapshot("run", "lead", (), tuple(agents))
    full, _nodes, _positions = swarm._draw(snapshot, swarm.Fold())
    assert len(full) > swarm.FOLD_CHARS

    doc = swarm.document(snapshot)
    assert len(doc.diagram) <= swarm.FOLD_CHARS
    draw_diagram(doc.diagram, get_palette("rose-pine"), 200)  # still drawn, not shown as text
    assert "Older work folded to fit" in doc.markdown
    shown_steps = {n.task for n in doc.nodes.values() if n.kind == "step"}
    # The newest open work keeps its steps; the oldest finished work lost its steps first.
    assert "t23" in shown_steps and "t0" not in shown_steps
    # Every arrow and code line names a box that is drawn.
    for line in doc.diagram.splitlines()[1:]:
        words = line.split()
        if "-->" in words or "-.->" in words:
            assert words[0] in doc.nodes and words[2] in doc.nodes, line
        elif words[:2] == ["%%", "code:"]:
            assert words[2] in doc.nodes, line


def test_a_folded_step_hands_its_branch_to_the_step_before_it():
    steps = (swarm.Step("a", True, "s1"), swarm.Step("b", True, "s2"), swarm.Step("c", False, "s3", after="s2"))
    t = swarm.Task("t1", "work", "w", (), steps, False)
    snapshot = swarm.Snapshot("run", "lead", (), (swarm.Agent("w", "working", tasks=(t,)),))
    diagram, nodes, _positions = swarm._draw(snapshot, swarm.Fold(trimmed={"t1"}))
    node = next(n for n, v in nodes.items() if v.kind == "task")
    assert f"  {node} --> {node}s2" in diagram.splitlines()
    assert f"{node}s0" not in nodes and f"{node}s1" not in nodes


def test_each_agent_goes_on_from_its_task_in_the_task_row(mailbox):
    snapshot = swarm.read_snapshot(mailbox, os.getpid(), 0)
    doc = swarm.document(snapshot)
    t2 = next(node for node, n in doc.nodes.items() if n.kind == "task" and n.task == "t2")
    geo = swarm_view.geometry(doc.diagram, (2, 1, 3))
    row = geo.boxes[t2].y
    # The steps sit right of the task, in its row; the branch from s1 on the row below.
    assert geo.boxes[f"{t2}s0"].y == row and geo.boxes[f"{t2}s1"].y == row
    assert geo.boxes[f"{t2}s0"].x > geo.boxes[t2].x and geo.boxes[f"{t2}s1"].x > geo.boxes[f"{t2}s0"].x
    assert geo.boxes[f"{t2}s2"].y > row and geo.boxes[f"{t2}s2"].x == geo.boxes[f"{t2}s1"].x
    # The task's agent sits in the same row.
    tester = next(node for node, n in doc.nodes.items() if n.kind == "agent" and n.agent == "tester")
    assert geo.boxes[tester].y == row


def test_a_still_swarm_paints_the_same_and_a_change_animates_then_settles(mailbox):
    palette = get_palette("rose-pine")
    motion = swarm_view.Motion()
    snapshot = swarm.read_snapshot(mailbox, os.getpid(), 0)
    motion.update(snapshot, swarm.document(snapshot), 0)
    code = motion.doc.diagram
    # With no one working nothing moves, so frames stay equal.
    idle = swarm_view.Motion()
    still = swarm.Snapshot(snapshot.label, snapshot.hub, snapshot.hub_tasks, tuple(a for a in snapshot.agents if a.state != "working"))
    idle.update(still, swarm.document(still), 0)
    first, _ = idle.overlay(idle.doc.diagram, (1, 0, 2), palette, 10)
    assert idle.overlay(idle.doc.diagram, (1, 0, 2), palette, 50)[0] == first
    assert not idle.moving(50)
    # A step gets done: it flashes, then settles.
    write(mailbox / "swarms/run/steps/tester.json", {"t2": [{"title": "unit", "done": True}, {"title": "rig", "done": True}]})
    changed = swarm.read_snapshot(mailbox, os.getpid(), 100)
    motion.update(changed, swarm.document(changed), 100)
    assert motion.done_at[("t2", 1)] == 100 and motion.done_at[("t2", -1)] == 100
    assert motion.moving(100.5)
    assert code  # drawn from the first document


async def wait_for(pilot, condition, seconds: float = 8.0) -> None:
    for _ in range(int(seconds / 0.05)):
        if condition():
            return
        await pilot.pause(0.05)
    raise AssertionError("condition not met in time")


def drawn_fence(app):
    fences = [f for f in app.query(DiagramFence) if f.is_mermaid and f.drawing is not None]
    return fences[0] if fences else None


async def test_a_new_version_changes_only_what_changed_without_the_placeholder(mailbox):
    app = BlueprintApp(swarm=mailbox / "views/rec.json")
    async with app.run_test(size=(140, 100)) as pilot:
        await wait_for(pilot, lambda: drawn_fence(app) is not None)
        document, fence = app.query_one(DocumentView), drawn_fence(app)
        # A new status shows in the table only: the drawing on screen stays the same widget.
        write(mailbox / "swarms/run/peers/writer.json", peer("writer", "lead", spawn="s1", finished=True, status="all done"))
        await wait_for(pilot, lambda: "all done" in app._shown_text)
        assert app.query_one(DocumentView) is document and drawn_fence(app) is fence
        # A step done changes the drawing: a new fence, drawn at once from the cache.
        write(mailbox / "swarms/run/steps/tester.json", {"t2": [{"id": "s1", "title": "unit", "done": True}, {"id": "s2", "title": "rig", "done": True}]})
        await wait_for(pilot, lambda: "✓ rig" in app._shown_text)
        changed = next(f for f in app.query(DiagramFence) if f.is_mermaid)
        assert changed is not fence and changed.drawing is not None and PLACEHOLDER not in str(changed._highlighted_code)
        assert app.query_one(DocumentView) is document


async def test_a_click_beside_the_boxes_neither_points_nor_scrolls(mailbox):
    app = BlueprintApp(swarm=mailbox / "views/rec.json")
    async with app.run_test(size=(140, 30)) as pilot:
        await wait_for(pilot, lambda: drawn_fence(app) is not None)
        body = app.query_one("#body")
        body.scroll_to(y=5, animate=False)
        await pilot.pause(0.2)
        fence = drawn_fence(app)
        await pilot.click(offset=(fence.region.right - 3, 6))
        await pilot.pause(0.3)
        assert not app.pointing and body.scroll_y == 5


async def test_a_click_on_a_task_shows_the_brief_behind_it(mailbox):
    app = BlueprintApp(swarm=mailbox / "views/rec.json")
    async with app.run_test(size=(140, 100)) as pilot:
        await wait_for(pilot, lambda: drawn_fence(app) is not None)
        await pilot.pause(0.3)  # the page lays out the drawing it just got
        fence = drawn_fence(app)
        geo = swarm_view.geometry(fence.code, fence.drawing.padding)
        node = next(n for n, it in app._motion.doc.nodes.items() if it.kind == "task" and it.task == "t1")
        box = geo.boxes[node]
        await pilot.click(fence.query_one("#code-content"), offset=(box.x + 2, box.y + 1))
        await wait_for(pilot, lambda: isinstance(app.screen, swarm_view.SwarmDetail))
        assert "Write a.txt containing alpha." in app.screen.markdown
        assert "Brief from lead to writer" in app.screen.markdown


def mouse(kind, x: int, y: int, button: int) -> events.MouseEvent:
    """A raw mouse event as the terminal driver posts it."""
    return kind(None, x, y, 0, 0, button, False, False, False, screen_x=x, screen_y=y)


async def test_dragging_moves_the_page_and_a_wide_diagram_and_is_not_a_click(mailbox):
    app = BlueprintApp(swarm=mailbox / "views/rec.json")
    async with app.run_test(size=(40, 16)) as pilot:
        await wait_for(pilot, lambda: drawn_fence(app) is not None)
        await pilot.pause(0.3)
        body, fence = app.query_one("#body"), drawn_fence(app)
        assert body.max_scroll_y > 3 and fence.max_scroll_x > 6
        body.scroll_to(y=fence.region.y - 2, animate=False)
        await pilot.pause(0.1)
        top, x, y = body.scroll_y, 20, 10
        # Press on the diagram and pull up and to the left: the page goes down, the diagram right.
        app.post_message(mouse(events.MouseDown, x, y, 1))
        for step in range(1, 4):
            app.post_message(mouse(events.MouseMove, x - 2 * step, y - step, 1))
            await pilot.pause(0.05)
        app.post_message(mouse(events.MouseUp, x - 6, y - 3, 1))
        await pilot.pause(0.3)
        assert (body.scroll_y, fence.scroll_x) == (top + 3, 6)
        assert app.screen is app.screen_stack[0]  # no box's details opened
        # A plain click still does what it did.
        await pilot.click(offset=(x - 6, y - 3))
        await pilot.pause(0.2)
        assert body.scroll_y == top + 3


async def test_the_pointer_and_an_animation_frame_rerender_only_what_changed(mailbox, monkeypatch):
    from herdr_blueprint import document

    rendered = []  # one entry per line of a drawing rendered
    to_strips = document.Visual.to_strips

    def counting(widget, *args, **kwargs):
        if isinstance(widget, document.DrawingLines):
            rendered.append(1)
        return to_strips(widget, *args, **kwargs)

    monkeypatch.setattr(document.Visual, "to_strips", staticmethod(counting))
    app = BlueprintApp(swarm=mailbox / "views/rec.json")
    async with app.run_test(size=(140, 60)) as pilot:
        await wait_for(pilot, lambda: drawn_fence(app) is not None)
        await pilot.pause(1.5)  # drawn, and the first animation settled
        fence = drawn_fence(app)
        lines = len(fence.drawing.text.plain.splitlines())
        rendered.clear()
        # The pointer sweeping over the drawing renders none of it again (Textual's Label did all of it, every move).
        for x in range(10, 60, 2):
            app.post_message(mouse(events.MouseMove, x, fence.region.y + 4, 0))
        await pilot.pause(0.3)
        assert rendered == []
        # An agent's box pulsing re-renders the rows of that box, not the whole drawing.
        motion = app._motion
        motion.changed["tester"] = time.time()
        app._play_motion()
        await pilot.pause(0.2)
        assert 0 < len(rendered) < lines / 2


def test_each_zoom_level_draws_and_zooming_out_shrinks_the_drawing(mailbox):
    from herdr_blueprint.diagram import LAYOUT_NAMES, draw_diagram

    snapshot = swarm.read_snapshot(mailbox, os.getpid(), 0)
    sizes = {}
    for zoom, (_limit, layout) in swarm.ZOOMS.items():
        drawing = draw_diagram(swarm.document(snapshot, zoom).diagram, get_palette("rose-pine"), 100)
        lines = drawing.text.plain.splitlines()
        sizes[zoom] = max(map(len, lines)) * len(lines)
        if layout is not None:
            assert drawing.padding == LAYOUT_NAMES[layout]
    levels = sorted(sizes)
    assert all(sizes[a] <= sizes[b] for a, b in zip(levels, levels[1:])), sizes
    assert sizes[levels[0]] < sizes[0] < sizes[levels[-1]]
    # Bird's-eye: a step is just its mark, a task its id.
    lines = swarm.document(snapshot, levels[0]).diagram.splitlines()
    assert any(line.endswith('["✓"]') for line in lines) and any('["✓ t1"]' in line for line in lines)


async def test_minus_plus_and_ctrl_wheel_zoom_the_drawing(mailbox):
    app = BlueprintApp(swarm=mailbox / "views/rec.json")
    async with app.run_test(size=(140, 60)) as pilot:
        await wait_for(pilot, lambda: drawn_fence(app) is not None)
        width = drawn_fence(app).drawing.text.cell_len
        await pilot.press("minus", "minus")
        await wait_for(pilot, lambda: drawn_fence(app) is not None and drawn_fence(app).drawing.text.cell_len < width)
        assert app._zoom == -2
        fence = drawn_fence(app)
        app.post_message(events.MouseScrollUp(None, 30, fence.region.y + 2, 0, 0, 0, False, False, True, screen_x=30, screen_y=fence.region.y + 2))
        await wait_for(pilot, lambda: app._zoom == -1)
        await pilot.press("0")
        await wait_for(pilot, lambda: drawn_fence(app) is not None and drawn_fence(app).drawing.text.cell_len == width)


async def test_a_note_about_an_agent_goes_to_the_hub_beside_the_view(mailbox):
    sent = []
    app = BlueprintApp(
        swarm=mailbox / "views/rec.json", source=Source("w1:p1", agent="omp"),
        prompter=lambda source, text: (sent.append(text), (True, "Sent to omp"))[1],
        refresher=lambda pane_id: Source(pane_id, agent="omp"),
    )
    async with app.run_test(size=(140, 100)) as pilot:
        await wait_for(pilot, lambda: drawn_fence(app) is not None)
        await pilot.press("e")
        await wait_for(pilot, lambda: app.pointing)
        tester = next(i for i, part in enumerate(app.parts) if app._node_of(part.id) and app._node_of(part.id).agent == "tester" and app._node_of(part.id).kind == "agent")
        app._select(tester)
        await pilot.press("enter")
        await wait_for(pilot, lambda: bool(app.query(NoteLine)))
        app.query_one(NoteLine).value = "stop after unit tests"
        await pilot.press("enter")
        await wait_for(pilot, lambda: bool(sent))
    assert sent[0].startswith('In the swarm view I pointed at agent "tester" (working; tasks: t2).')
    assert "pass it on to tester with peer_send user_quote" in sent[0]
    assert "stop after unit tests" in sent[0]
