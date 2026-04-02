import React, { useState, useRef, useEffect, useCallback } from 'react'
import TaskRow from './TaskRow'
import type { Task, Folder } from '@shared/types'

interface Props {
  folders: Folder[]
  selectedTaskId: number | null
  week: string
  onSelectTask: (id: number) => void
  onToggleTask: (id: number) => void
  onCreateFolder: () => void
  onRenameFolder: (folderId: number, name: string) => void
  onToggleFolderCollapse: (folderId: number) => void
  onDeleteFolder: (folderId: number) => void
  onSetTaskFolder: (taskId: number, folderId: number | null) => void
  onUpdateFolderColor: (folderId: number, color: string) => void
  onReorderFolders: (folderIds: number[]) => void
  onReorderTasks: (taskIds: number[]) => void
  folderColors: string[]
  ptyStatuses?: Record<string, string>
  onToggleUrgent?: (id: number) => void
}

function clearFolderDropIndicators(container: HTMLElement) {
  container.querySelectorAll('.drop-before, .drop-after').forEach(
    el => el.classList.remove('drop-before', 'drop-after')
  )
}

export default function FoldersPanel({
  folders, selectedTaskId, week,
  onSelectTask, onToggleTask,
  onCreateFolder, onRenameFolder, onToggleFolderCollapse,
  onDeleteFolder, onSetTaskFolder, onUpdateFolderColor,
  onReorderFolders, onReorderTasks, folderColors, ptyStatuses = {},
  onToggleUrgent,
}: Props) {

  // Folder reorder drag handlers
  const handleFolderListDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('application/roca-folder')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'

    const container = e.currentTarget as HTMLElement
    clearFolderDropIndicators(container)

    const target = (e.target as HTMLElement).closest('[data-folder-id]') as HTMLElement
    if (!target || !container.contains(target)) return

    const rect = target.getBoundingClientRect()
    const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    target.classList.add(position === 'before' ? 'drop-before' : 'drop-after')
  }, [])

  const handleFolderListDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    clearFolderDropIndicators(e.currentTarget as HTMLElement)

    const draggedId = Number(e.dataTransfer.getData('application/roca-folder'))
    if (!draggedId) return

    const target = (e.target as HTMLElement).closest('[data-folder-id]') as HTMLElement
    if (!target) return

    const targetId = Number(target.getAttribute('data-folder-id'))
    if (draggedId === targetId) return

    const currentIds = folders.map(f => f.id)
    if (!currentIds.includes(draggedId)) return

    const newIds = currentIds.filter(id => id !== draggedId)
    const insertIdx = newIds.indexOf(targetId)
    if (insertIdx === -1) return
    const rect = target.getBoundingClientRect()
    const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    newIds.splice(position === 'before' ? insertIdx : insertIdx + 1, 0, draggedId)

    onReorderFolders(newIds)
  }, [folders, onReorderFolders])

  const handleFolderListDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      clearFolderDropIndicators(e.currentTarget as HTMLElement)
    }
  }, [])

  const handleRemoveTask = useCallback((taskId: number) => onSetTaskFolder(taskId, null), [onSetTaskFolder])

  return (
    <section>
      {/* Folder section header */}
      <div className="flex items-center justify-between mb-3 px-1">
        <h2 className="text-[9px] font-semibold uppercase tracking-[0.1em] text-text-3">
          Folders
        </h2>
        <button
          onClick={onCreateFolder}
          aria-label="Create new folder"
          title="New folder"
          className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[9px] font-medium text-purple-1/60 hover:text-purple-1 hover:bg-purple-2 transition-all cursor-pointer"
        >
          <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4"/>
          </svg>
          New
        </button>
      </div>

      {folders.length > 0 && (
        <div
          className="space-y-1.5"
          id="folders-list"
          onDragOver={handleFolderListDragOver}
          onDrop={handleFolderListDrop}
          onDragLeave={handleFolderListDragLeave}
        >
          {folders.map(folder => (
            <FolderItem
              key={folder.id}
              folder={folder}
              selectedTaskId={selectedTaskId}
              onSelectTask={onSelectTask}
              onToggleTask={onToggleTask}
              onRename={onRenameFolder}
              onToggleCollapse={onToggleFolderCollapse}
              onDelete={onDeleteFolder}
              onRemoveTask={handleRemoveTask}
              onSetTaskFolder={onSetTaskFolder}
              onUpdateColor={onUpdateFolderColor}
              onReorderTasks={onReorderTasks}
              ptyStatuses={ptyStatuses}
              folderColors={folderColors}
              onToggleUrgent={onToggleUrgent}
            />
          ))}
        </div>
      )}
    </section>
  )
}

// Individual folder item
interface FolderItemProps {
  folder: Folder
  selectedTaskId: number | null
  onSelectTask: (id: number) => void
  onToggleTask: (id: number) => void
  onRename: (folderId: number, name: string) => void
  onToggleCollapse: (folderId: number) => void
  onDelete: (folderId: number) => void
  onRemoveTask: (taskId: number) => void
  onSetTaskFolder: (taskId: number, folderId: number | null) => void
  onUpdateColor: (folderId: number, color: string) => void
  onReorderTasks: (taskIds: number[]) => void
  folderColors: string[]
  ptyStatuses?: Record<string, string>
  onToggleUrgent?: (id: number) => void
}

const FolderItem = React.memo(function FolderItem({
  folder, selectedTaskId, onSelectTask, onToggleTask,
  onRename, onToggleCollapse, onDelete, onRemoveTask,
  onSetTaskFolder, onUpdateColor, onReorderTasks,
  folderColors, ptyStatuses = {}, onToggleUrgent
}: FolderItemProps) {
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(folder.name)
  const [showColorPicker, setShowColorPicker] = useState(false)
  const [colorPickerPos, setColorPickerPos] = useState<{ top: number; right: number } | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const colorPickerRef = useRef<HTMLDivElement>(null)
  const colorTriggerRef = useRef<HTMLButtonElement>(null)
  const confirmDeleteRef = useRef<HTMLDivElement>(null)
  const skipNextClickRef = useRef(false) // set true on confirmation dismissal, cleared next rAF

  useEffect(() => {
    if (renaming && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renaming])

  // Keep rename input in sync when folder.name changes externally (e.g., sync)
  useEffect(() => {
    if (!renaming) setRenameValue(folder.name)
  }, [folder.name, renaming])

  // Close color picker on click outside, scroll, or resize
  useEffect(() => {
    if (!showColorPicker) return
    function handleClick(e: MouseEvent) {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setShowColorPicker(false)
        setColorPickerPos(null)
        colorTriggerRef.current?.focus()
      }
    }
    function handleClose() {
      setShowColorPicker(false)
      setColorPickerPos(null)
    }
    document.addEventListener('mousedown', handleClick)
    window.addEventListener('resize', handleClose)
    window.addEventListener('scroll', handleClose, true)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      window.removeEventListener('resize', handleClose)
      window.removeEventListener('scroll', handleClose, true)
    }
  }, [showColorPicker])

  // Close delete confirmation on click outside
  // skipNextClickRef prevents the folder header's onClick from also collapsing
  // the folder when the user clicks outside the confirm dialog on the header row.
  useEffect(() => {
    if (!confirmingDelete) return
    function handleClick(e: MouseEvent) {
      if (confirmDeleteRef.current && !confirmDeleteRef.current.contains(e.target as Node)) {
        setConfirmingDelete(false)
        skipNextClickRef.current = true
        requestAnimationFrame(() => { skipNextClickRef.current = false })
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [confirmingDelete])

  function handleRenameSubmit() {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== folder.name) {
      onRename(folder.id, trimmed)
    }
    setRenaming(false)
  }

  function handleDeleteClick(e: React.MouseEvent) {
    e.stopPropagation()
    setConfirmingDelete(true)
  }

  // Task drop onto folder drop zone
  const handleTaskDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('application/roca-task')) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    ;(e.currentTarget as HTMLElement).classList.add('drag-over')
  }, [])

  const handleTaskDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      ;(e.currentTarget as HTMLElement).classList.remove('drag-over')
    }
  }, [])

  const handleTaskDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).classList.remove('drag-over')

    const draggedId = Number(e.dataTransfer.getData('application/roca-task'))
    if (!draggedId) return

    // Move task to this folder
    onSetTaskFolder(draggedId, folder.id)
  }, [folder.id, onSetTaskFolder])

  // Task reorder within folder
  const handleInFolderDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('application/roca-task')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'

    const container = e.currentTarget as HTMLElement
    container.querySelectorAll('.drop-before, .drop-after').forEach(
      el => el.classList.remove('drop-before', 'drop-after')
    )

    const target = (e.target as HTMLElement).closest('[data-task-id]') as HTMLElement
    if (!target || !container.contains(target)) return

    const rect = target.getBoundingClientRect()
    const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    target.classList.add(position === 'before' ? 'drop-before' : 'drop-after')
  }, [])

  const handleInFolderDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).classList.remove('drag-over')
    ;(e.currentTarget as HTMLElement).querySelectorAll('.drop-before, .drop-after').forEach(
      el => el.classList.remove('drop-before', 'drop-after')
    )

    const draggedId = Number(e.dataTransfer.getData('application/roca-task'))
    if (!draggedId) return

    const tasks = folder.tasks || []

    // If task is not in this folder, move it here
    if (!tasks.some(t => t.id === draggedId)) {
      onSetTaskFolder(draggedId, folder.id)
      return
    }

    // Reorder within folder
    const target = (e.target as HTMLElement).closest('[data-task-id]') as HTMLElement
    if (!target) return

    const targetId = Number(target.getAttribute('data-task-id'))
    if (draggedId === targetId) return

    const currentIds = tasks.map(t => t.id)
    const newIds = currentIds.filter(id => id !== draggedId)
    const insertIdx = newIds.indexOf(targetId)
    if (insertIdx === -1) return
    const rect = target.getBoundingClientRect()
    const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    newIds.splice(position === 'before' ? insertIdx : insertIdx + 1, 0, draggedId)

    onReorderTasks(newIds)
  }, [folder.tasks, folder.id, onReorderTasks, onSetTaskFolder])

  const isCollapsed = !!folder.collapsed
  const tasks = folder.tasks || []

  return (
    <div
      className="folder-item rounded-xl overflow-hidden transition-all"
      data-folder-id={folder.id}
      style={{
        background: `color-mix(in srgb, ${folder.color} 4%, transparent)`,
        border: `1px solid color-mix(in srgb, ${folder.color} 10%, transparent)`,
      }}
    >
      {/* Folder header row */}
      <div
        className="flex items-center gap-1.5 px-2 py-2 cursor-pointer select-none group"
        onClick={() => {
          if (skipNextClickRef.current) return
          onToggleCollapse(folder.id)
        }}
        role="button"
        tabIndex={0}
        aria-expanded={!isCollapsed}
        aria-label={`${folder.name}, ${isCollapsed ? 'collapsed' : 'expanded'}, click to toggle`}
        onKeyDown={(e) => {
          if (e.key === 'F2') { e.preventDefault(); setRenaming(true) }
          else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleCollapse(folder.id) }
        }}
      >
        {/* Drag handle for folder reorder */}
        <div
          aria-hidden="true"
          className="folder-drag-handle w-3 shrink-0 cursor-grab opacity-0 group-hover:opacity-40 hover:!opacity-80 transition-opacity text-text-3"
          draggable
          onDragStart={(e) => {
            e.stopPropagation()
            const folderEl = e.currentTarget.closest('[data-folder-id]') as HTMLElement
            if (folderEl) {
              e.dataTransfer.setDragImage(folderEl, 20, 20)
              folderEl.classList.add('sortable-chosen')
            }
            e.dataTransfer.setData('application/roca-folder', String(folder.id))
            e.dataTransfer.effectAllowed = 'move'
          }}
          onDragEnd={() => {
            document.querySelectorAll('.sortable-chosen, .drop-before, .drop-after').forEach(
              el => el.classList.remove('sortable-chosen', 'drop-before', 'drop-after')
            )
          }}
          onClick={e => e.stopPropagation()}
        >
          <svg className="w-3 h-4" viewBox="0 0 10 16" fill="currentColor">
            <circle cx="3" cy="2" r="1.2"/><circle cx="7" cy="2" r="1.2"/>
            <circle cx="3" cy="6" r="1.2"/><circle cx="7" cy="6" r="1.2"/>
            <circle cx="3" cy="10" r="1.2"/><circle cx="7" cy="10" r="1.2"/>
            <circle cx="3" cy="14" r="1.2"/><circle cx="7" cy="14" r="1.2"/>
          </svg>
        </div>

        {/* Chevron */}
        <svg
          className={`w-3 h-3 transition-transform duration-200 shrink-0 ${isCollapsed ? '' : 'rotate-90'}`}
          fill="none" stroke={folder.color} viewBox="0 0 24 24" strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
        </svg>

        {/* Folder icon */}
        <svg className="w-3.5 h-3.5 shrink-0" fill={folder.color} viewBox="0 0 24 24" opacity="0.7">
          <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
        </svg>

        {/* Name / rename form */}
        {renaming ? (
          <form
            className="flex-1 min-w-0"
            onSubmit={e => { e.preventDefault(); e.stopPropagation(); handleRenameSubmit() }}
            onClick={e => e.stopPropagation()}
          >
            <input
              ref={renameInputRef}
              type="text"
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onBlur={handleRenameSubmit}
              onKeyDown={e => {
                if (e.key === 'Escape') { setRenameValue(folder.name); setRenaming(false) }
              }}
              className="w-full bg-surface-2 text-[11px] font-medium text-text-1 rounded-md px-1.5 py-0.5 border border-purple-1/30 focus:outline-none focus:border-purple-1/60"
            />
          </form>
        ) : (
          <button
            type="button"
            className="folder-name text-[11px] font-medium text-text-1 truncate flex-1 cursor-pointer text-left bg-transparent border-none p-0"
            onClick={e => { e.stopPropagation(); setRenaming(true) }}
            onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); setRenaming(true) } }}
            title="Click to rename (F2)"
          >
            {folder.name}
          </button>
        )}

        {/* Count */}
        <span className="text-[9px] text-text-3/60 shrink-0">{tasks.length}</span>

        {/* Actions (hover) */}
        <div
          className={`flex items-center gap-0 transition-opacity duration-150 shrink-0 ${
            confirmingDelete ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
          onClick={e => e.stopPropagation()}
        >
          {confirmingDelete ? (
            <div ref={confirmDeleteRef} className="flex items-center gap-1">
              <span className="text-[9px] text-text-3/60 italic">Delete folder?</span>
              <button
                onClick={() => setConfirmingDelete(false)}
                className="px-1.5 py-0.5 rounded text-[9px] text-text-3 hover:text-text-1 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => { setConfirmingDelete(false); onDelete(folder.id) }}
                className="px-1.5 py-0.5 rounded text-[9px] font-medium text-red-1/60 hover:text-red-1 hover:bg-red-2 transition-colors cursor-pointer"
              >
                Delete
              </button>
            </div>
          ) : (
            <>
              {/* Color picker */}
              <div className="relative" ref={colorPickerRef}>
                <button
                  ref={colorTriggerRef}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (showColorPicker) {
                      setShowColorPicker(false)
                      setColorPickerPos(null)
                    } else {
                      const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
                      setColorPickerPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
                      setShowColorPicker(true)
                    }
                  }}
                  className="p-1 rounded-md hover:bg-black/[0.06] transition-colors cursor-pointer"
                  aria-label={`Change folder color. Current: ${folder.color}`}
                  title="Change color"
                >
                  <div className="w-2.5 h-2.5 rounded-full" style={{ background: folder.color }} />
                </button>
                {showColorPicker && colorPickerPos && (
                  <div
                    role="menu"
                    aria-label="Choose folder color"
                    className="p-2 bg-surface-1 border border-black/[0.1] rounded-xl shadow-2xl flex gap-1.5 flex-wrap w-[108px]"
                    style={{ position: 'fixed', top: colorPickerPos.top, right: colorPickerPos.right, zIndex: 9999 }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setShowColorPicker(false)
                        setColorPickerPos(null)
                        colorTriggerRef.current?.focus()
                        return
                      }
                      if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
                        e.preventDefault()
                        const btns = Array.from<HTMLElement>(e.currentTarget.querySelectorAll('button'))
                        if (!btns.length) return
                        const idx = btns.indexOf(document.activeElement as HTMLElement)
                        let next: HTMLElement
                        if (e.key === 'Home') next = btns[0]
                        else if (e.key === 'End') next = btns[btns.length - 1]
                        else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = btns[(idx + 1) % btns.length]
                        else next = btns[(idx - 1 + btns.length) % btns.length]
                        next?.focus()
                      }
                    }}
                  >
                    {folderColors.map(c => (
                      <button
                        key={c}
                        role="menuitemradio"
                        aria-checked={c === folder.color}
                        onClick={() => { onUpdateColor(folder.id, c); setShowColorPicker(false); setColorPickerPos(null) }}
                        aria-label={`Set folder color to ${c}`}
                        className={`w-4 h-4 rounded-full border-2 transition-transform hover:scale-125 cursor-pointer ${
                          c === folder.color ? 'border-white' : 'border-transparent'
                        }`}
                        style={{ background: c }}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* Delete */}
              <button
                onClick={handleDeleteClick}
                aria-label={`Delete folder: ${folder.name}`}
                className="p-1 rounded-md hover:bg-red-2 text-text-3/40 hover:text-red-1 transition-colors cursor-pointer"
              >
                <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                </svg>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Folder contents (collapsible) */}
      {!isCollapsed && (
        <div className="folder-body" style={{ borderTop: `1px solid color-mix(in srgb, ${folder.color} 7%, transparent)` }}>
          <div
            className="folder-drop-zone px-2 py-1 space-y-0.5 min-h-[52px]"
            data-folder-drop-zone={folder.id}
            onDragOver={tasks.length > 0 ? handleInFolderDragOver : handleTaskDragOver}
            onDragLeave={handleTaskDragLeave}
            onDrop={tasks.length > 0 ? handleInFolderDrop : handleTaskDrop}
          >
            {tasks.length > 0 ? (
              tasks.map(task => (
                <TaskRow
                  key={task.id}
                  task={task}
                  isSelected={task.id === selectedTaskId}
                  onSelect={onSelectTask}
                  onToggle={onToggleTask}
                  onToggleUrgent={onToggleUrgent}
                  ptyStatus={ptyStatuses[`task-${task.id}`]}
                />
              ))
            ) : (
              <div className="folder-empty-state text-center border border-dashed border-black/[0.08] rounded-xl mx-1 my-1 py-3">
                <p className="text-[9px] text-text-3/60">Drop tasks here</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
})
