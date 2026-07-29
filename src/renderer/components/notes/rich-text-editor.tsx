import React, { useEffect, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from 'tiptap-markdown'
import { NotesToolbar } from './notes-toolbar'
import './notes-editor.css'

// A WYSIWYG markdown editor. `value` is GitHub-flavored markdown; `onChange`
// emits markdown on every edit. The component is a *controlled* editor without
// remounting: it serializes to markdown on edit, and re-hydrates from `value`
// only when the change came from outside (a different doc, or a live edit in
// the app's other notes surface) — tracked via `lastMd` so a user's own
// keystrokes never trigger a content reset (which would drop the cursor).
interface Props {
  value: string
  onChange: (markdown: string) => void
  placeholder?: string
  compact?: boolean
  editable?: boolean
}

export function RichTextEditor({ value, onChange, placeholder, compact, editable = true }: Props) {
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange
  const lastMd = useRef(value)

  const editor = useEditor({
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editable,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Link.configure({ openOnClick: true, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer nofollow' } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: placeholder ?? 'Start writing…' }),
      Markdown.configure({ html: false, transformPastedText: true, transformCopiedText: true, breaks: true }),
    ],
    content: value,
    editorProps: {
      attributes: {
        class: `${compact ? 'px-5 py-4' : 'px-8 py-6'} min-h-full focus:outline-none`,
      },
    },
    onUpdate: ({ editor }) => {
      const md = editor.storage.markdown.getMarkdown()
      lastMd.current = md
      onChangeRef.current(md)
    },
  }, [])

  // Re-hydrate only on external changes (doc switch or a sync from the other
  // surface). `false` = don't emit an update, so this never loops back.
  useEffect(() => {
    if (!editor) return
    if (value !== lastMd.current) {
      lastMd.current = value
      editor.commands.setContent(value, false)
    }
  }, [value, editor])

  return (
    <div className={`roca-notes-editor ${compact ? 'roca-notes-compact' : ''} flex flex-col flex-1 min-h-0`}>
      {editable && <NotesToolbar editor={editor} compact={compact} />}
      <div className="flex-1 min-h-0 overflow-y-auto" onClick={() => editable && editor?.chain().focus().run()}>
        <EditorContent editor={editor} className="min-h-full" />
      </div>
    </div>
  )
}
