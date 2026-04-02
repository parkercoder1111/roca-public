# Feature: "Done" Action Kills Terminal & Navigates Home

**Type:** Feature Request
**Date:** 2026-03-30
**Priority:** Medium

## Summary

When a user marks a task as "Done" (checkbox or button), ROCA should:
1. Kill any live terminal session attached to that task
2. Navigate back to the home screen / task list

## Current Behavior

Marking a task as done only updates its status. The terminal session (if running) stays alive, and the user remains on the task view.

## Expected Behavior

1. User clicks "Done" or checks off a task
2. If a terminal session is active for that task, terminate it (clean kill -- SIGTERM, then SIGKILL if needed)
3. Transition the UI back to the task list / home screen
4. Task status updates to completed

## UX Rationale

"Done" is a close-out gesture. The user is signaling they're finished with the entire task context, not just the status. Leaving a dead terminal session open after completion is confusing. The natural next action is picking up the next task, so navigate them there.

## Implementation Notes

- Check for active terminal process (pty) associated with the task
- Send SIGTERM, wait briefly, SIGKILL if still alive
- Clean up any task-level state (temp files, locks)
- Animate transition back to home/task list
- Consider a brief confirmation if the terminal is mid-output ("Terminal is still running. Mark done anyway?")
