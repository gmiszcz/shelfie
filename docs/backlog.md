# Backlog

Ideas the user asked for that are not built yet. Move an item to `docs/features/` when it ships.

## Universal UI agent (needs a design talk with the user first)

- The UI agent must work with any new tab or control without code changes in the agent.
- Idea: components declare themselves (anchors) in a runtime registry with id, kind, label,
  current state, allowed values and a setter. A script/hook builds the navigation schema on the
  fly from that registry; the agent gets generic tools (`describe_ui`, `get_state`, `set`,
  `invoke`, `navigate`) and reads the schema instead of hard-coded per-action tools.

## Voice

- Transcribe + AG-UI unification (later).

## Multi-user

- Multi-user, authorization, user and admin panels.
