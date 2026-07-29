import React, { useEffect, useReducer, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'

// The formatting bar bound to a TipTap editor. Buttons reflect the current
// selection's active marks/nodes; because we opt out of TipTap's per-transaction
// re-render for performance, we force our own re-render on every transaction so
// the active states stay in sync with the cursor. The link control uses an
// inline input (Electron's renderer has no window.prompt).
interface Props { editor: Editor | null; compact?: boolean }

function Btn({
  onClick, active, disabled, title, children,
}: {
  onClick: () => void
  active?: boolean
  disabled?: boolean
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onMouseDown={e => e.preventDefault()} // keep editor selection while clicking
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`flex items-center justify-center w-7 h-7 rounded-md text-[12px] transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default ${
        active ? 'bg-black/[0.08] text-text-1' : 'text-text-3 hover:text-text-1 hover:bg-black/[0.04]'
      }`}
    >
      {children}
    </button>
  )
}

function Divider() {
  return <div className="w-px h-4 mx-1 bg-black/[0.08]" />
}

export function NotesToolbar({ editor, compact }: Props) {
  const [, force] = useReducer((x: number) => x + 1, 0)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkValue, setLinkValue] = useState('')
  const linkInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editor) return
    const update = () => force()
    editor.on('transaction', update)
    editor.on('selectionUpdate', update)
    return () => { editor.off('transaction', update); editor.off('selectionUpdate', update) }
  }, [editor])

  useEffect(() => { if (linkOpen) linkInputRef.current?.focus() }, [linkOpen])

  if (!editor) return null

  const openLink = () => {
    setLinkValue((editor.getAttributes('link').href as string | undefined) ?? 'https://')
    setLinkOpen(true)
  }
  const applyLink = () => {
    const url = linkValue.trim()
    if (url === '') editor.chain().focus().extendMarkRange('link').unsetLink().run()
    else editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
    setLinkOpen(false)
  }

  const icon = 'w-3.5 h-3.5'
  return (
    <div className="border-b border-black/[0.06]">
      <div className={`flex items-center gap-0.5 flex-wrap ${compact ? 'px-3 py-1.5' : 'px-5 py-2'}`}>
        <Btn title="Bold (⌘B)" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
          <span className="font-bold">B</span>
        </Btn>
        <Btn title="Italic (⌘I)" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
          <span className="italic font-serif">I</span>
        </Btn>
        <Btn title="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}>
          <span className="line-through">S</span>
        </Btn>

        <Divider />

        <Btn title="Heading 1" active={editor.isActive('heading', { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
          <span className="font-semibold text-[11px]">H1</span>
        </Btn>
        <Btn title="Heading 2" active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
          <span className="font-semibold text-[11px]">H2</span>
        </Btn>
        <Btn title="Heading 3" active={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
          <span className="font-semibold text-[11px]">H3</span>
        </Btn>

        <Divider />

        <Btn title="Bullet list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>
          <svg className={icon} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
        </Btn>
        <Btn title="Numbered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
          <svg className={icon} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 6h13M8 12h13M8 18h13" /><text x="1.5" y="8" fontSize="7" fill="currentColor" stroke="none">1</text><text x="1.5" y="14" fontSize="7" fill="currentColor" stroke="none">2</text><text x="1.5" y="20" fontSize="7" fill="currentColor" stroke="none">3</text></svg>
        </Btn>
        <Btn title="Checklist" active={editor.isActive('taskList')} onClick={() => editor.chain().focus().toggleTaskList().run()}>
          <svg className={icon} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 11l2 2 4-4M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z" /></svg>
        </Btn>

        <Divider />

        <Btn title="Link" active={editor.isActive('link') || linkOpen} onClick={openLink}>
          <svg className={icon} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 015.656 5.656l-3 3a4 4 0 01-5.656-5.656m-.828-.828a4 4 0 00-5.656 5.656l3 3a4 4 0 005.656 0" /></svg>
        </Btn>
      </div>

      {linkOpen && (
        <div className={`flex items-center gap-2 ${compact ? 'px-3 pb-2' : 'px-5 pb-2'}`}>
          <input
            ref={linkInputRef}
            value={linkValue}
            onChange={e => setLinkValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); applyLink() }
              if (e.key === 'Escape') { e.preventDefault(); setLinkOpen(false) }
            }}
            placeholder="https://…  (empty to remove)"
            className="flex-1 px-2 py-1 rounded-md text-[11px] bg-black/[0.04] text-text-1 focus:outline-none focus:ring-1 focus:ring-purple-1/40"
          />
          <button type="button" onMouseDown={e => e.preventDefault()} onClick={applyLink}
            className="px-2 py-1 rounded-md text-[11px] font-medium text-text-1 bg-black/[0.06] hover:bg-black/[0.10] transition-colors cursor-pointer">
            Apply
          </button>
        </div>
      )}
    </div>
  )
}
