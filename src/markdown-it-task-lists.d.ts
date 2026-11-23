/** markdown-it-task-lists ships without type definitions. */
declare module 'markdown-it-task-lists' {
    import type { PluginWithOptions } from 'markdown-it';

    /** Options of markdown-it-task-lists. */
    interface TaskListsOptions {
        /** Leave the checkboxes clickable (without the `disabled` attribute). */
        enabled?: boolean;
        /** Wrap each item's text in a `<label>`. */
        label?: boolean;
        /** Put the `<label>` after the checkbox instead of around the item. */
        labelAfter?: boolean;
    }

    const taskLists: PluginWithOptions<TaskListsOptions>;
    export default taskLists;
}
