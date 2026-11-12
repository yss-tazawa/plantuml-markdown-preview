/**
 * @module notify-once
 * @description Guidance notifications that are never shown twice at once.
 *
 * Key behaviors:
 * - Shows a notification without awaiting it, so start and render paths never block on the user's answer
 * - Skips a notification whose text is already on screen; it can show again once the user answered or dismissed it
 * - Runs the handler of the action the user chose
 * - Keeps a bounded record of the notifications it showed, for test hooks ({@link getShownGuidance})
 */
import * as vscode from 'vscode';

/** A button of a guidance notification. */
export interface GuidanceAction {
    /** Button label. */
    label: string;
    /** Runs when the user chooses the button (omitted: the button only closes the notification). */
    run?: () => unknown;
}

/** A guidance notification: its text, severity and buttons. */
export interface Guidance {
    /** Notification text (also the de-duplication key). */
    message: string;
    /** 'error' shows an error notification, 'warning' a warning one. */
    severity: 'error' | 'warning';
    /** Buttons, in display order. */
    actions: GuidanceAction[];
}

/** A guidance notification that was shown. */
export interface ShownGuidance {
    /** Sequence number, counting from 1 since activation and never reused. */
    seq: number;
    /** Notification text. */
    message: string;
}

/** Messages of the notifications currently on screen. */
const onScreen = new Set<string>();

/** Maximum number of entries {@link shown} keeps. */
const SHOWN_LIMIT = 100;
/** Notifications shown, oldest first (the most recent ones only). */
const shown: ShownGuidance[] = [];
/** Sequence number of the latest entry in {@link shown}. */
let shownSeq = 0;

/**
 * Get the notifications shown so far (for test hooks); a message that was already
 * on screen is not shown again, so it is not listed again.
 *
 * @returns A copy of the most recent entries, oldest first.
 */
export function getShownGuidance(): ShownGuidance[] {
    return [...shown];
}

/**
 * Show a guidance notification without awaiting it, unless the same message is
 * already on screen. The chosen action runs once the user answers.
 *
 * @param guidance - Text, severity and buttons of the notification.
 */
export function notifyOnce(guidance: Guidance): void {
    const { message, severity, actions } = guidance;
    if (onScreen.has(message)) return;
    onScreen.add(message);
    shown.push({ seq: ++shownSeq, message });
    if (shown.length > SHOWN_LIMIT) shown.splice(0, shown.length - SHOWN_LIMIT);
    const labels = actions.map(action => action.label);
    const answer = severity === 'error'
        ? vscode.window.showErrorMessage(message, ...labels)
        : vscode.window.showWarningMessage(message, ...labels);
    void Promise.resolve(answer).then(
        (label) => {
            onScreen.delete(message);
            return actions.find(action => action.label === label)?.run?.();
        },
        () => { onScreen.delete(message); },
    ).catch(() => { /* action handlers report their own failures */ });
}
