# Collision Guard

A Claude Code mod for running more than one session in the same project folder at
the same time. It does two things.

**It holds an edit when another session got there first.** Before every `Edit`,
`Write` and `NotebookEdit`, it checks whether another live session wrote that same
file in the last 30 minutes. If one did, it stops and asks, naming the session, how
long ago, and what that session is working on. The choices are **Proceed**, **Move
to a worktree**, **Cancel**, or typing something else — anything typed is passed to
Claude as the instruction to follow instead of the edit.

**It shows a band above the prompt in every session.** Each session's band lists the
others open in the same folder, what each is working on, and whether that work is
in progress (`◌`) or done (`✓`). Every band refreshes every 15 seconds and whenever
you send a prompt, so all of them stay current. A **Hide** button puts it away for
the rest of the session.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install collision-guard --marketplace Baskers1/collision-guard
```

Answer `y` to add the marketplace, then pick a scope (user scope installs it
for every project).

## How sessions see each other

Each session keeps one small JSON file at `.claude/collision-guard/<session-id>.json`
in the project root, holding its label, what it is working on, and the files it has
written with the time of each. One file per session means sessions never overwrite
each other's notes. A session whose file has not been touched for 90 seconds is
treated as closed and drops off the band. Add `.claude/collision-guard/` to your
`.gitignore`.

## Notes

- Nothing is blocked silently: every hold is explained to Claude so it does not
  simply retry the edit.
- In an unattended run (`claude -p`, where there is no one to ask) the edit goes
  ahead and a line is written to the transcript instead.
- If the check itself fails, the edit is held rather than let through.

## Settings worth knowing

The windows are constants at the top of `hooks/register.tsx`: `WINDOW_MS` (30
minutes), `LIVE_MS` (90 seconds) and `BEAT_MS` (15 seconds).
