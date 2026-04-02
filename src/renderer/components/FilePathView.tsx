import React, { useState, useEffect, useRef, useCallback } from 'react'
import { TerminalSession } from '../terminal/TerminalSession'
import { renderMarkdown } from '../lib/renderMarkdown'
import { formatDate } from '../lib/formatDate'

// ── Types ────────────────────────────────────────────────────────────────────

interface DirEntry {
  name: string
  path: string
  isDirectory: boolean
  size?: number
  modifiedAt?: string
  childCount?: number
}

interface TreeNode extends DirEntry {
  children?: TreeNode[]
  loaded: boolean
  expanded: boolean
}

interface AgentInfo {
  name: string
  label: string
  running: boolean
  pid: number | null
  schedule: string | null
}

// ── Size formatting ──────────────────────────────────────────────────────────

// ~4 chars per token on average for English/code text
const TEXT_EXTS = new Set(['md', 'skill', 'py', 'sh', 'bash', 'ts', 'tsx', 'js', 'jsx', 'json', 'jsonl', 'toml', 'yaml', 'yml', 'plist', 'log', 'csv', 'txt', 'sql', 'html', 'css', 'xml'])

function isTextFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return TEXT_EXTS.has(ext)
}

function formatSizeContext(bytes: number | undefined, name: string): string {
  if (bytes == null) return ''
  if (isTextFile(name)) {
    // Estimate tokens: ~4 bytes per token for English/code
    const tokens = Math.round(bytes / 4)
    if (tokens < 1000) return `~${tokens} tok`
    return `~${(tokens / 1000).toFixed(1)}k tok`
  }
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

// ── Minimal SVG icons ────────────────────────────────────────────────────────

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg className={`w-3 h-3 text-text-3/60 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
      fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  )
}

function FolderIcon({ open }: { open: boolean }) {
  return open ? (
    <svg className="w-3.5 h-3.5 text-purple-1/70" fill="currentColor" viewBox="0 0 20 20">
      <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v1H2V6z" />
      <path fillRule="evenodd" d="M2 9h16v5a2 2 0 01-2 2H4a2 2 0 01-2-2V9z" clipRule="evenodd" />
    </svg>
  ) : (
    <svg className="w-3.5 h-3.5 text-text-3/50" fill="currentColor" viewBox="0 0 20 20">
      <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
    </svg>
  )
}

function fileIconSvg(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  /* file-type accent colors — intentionally raw Tailwind; these are decorative tints, not interactive states */
  const colors: Record<string, string> = {
    py: 'text-blue-500/70', sh: 'text-green-600/70', bash: 'text-green-600/70',
    md: 'text-text-3/50', skill: 'text-text-3/50',
    json: 'text-amber-500/60', jsonl: 'text-amber-500/60', toml: 'text-amber-500/60', yaml: 'text-amber-500/60', yml: 'text-amber-500/60',
    ts: 'text-blue-1/70', tsx: 'text-blue-1/70', js: 'text-yellow-500/70', jsx: 'text-yellow-500/70',
    plist: 'text-text-3/40', log: 'text-text-3/35', csv: 'text-text-3/35',
  }
  const color = colors[ext] || 'text-text-3/35'
  // Use doc icon for text, generic for others
  if (ext === 'md' || ext === 'skill') return (
    <svg className={`w-3.5 h-3.5 ${color}`} fill="currentColor" viewBox="0 0 20 20">
      <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
    </svg>
  )
  return (
    <svg className={`w-3.5 h-3.5 ${color}`} fill="currentColor" viewBox="0 0 20 20">
      <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
    </svg>
  )
}

function TerminalIcon({ className }: { className?: string }) {
  return (
    <svg className={className || 'w-3 h-3'} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
    </svg>
  )
}

// ── TreeItem ─────────────────────────────────────────────────────────────────

function TreeItem({
  node,
  depth,
  selectedPath,
  onToggle,
  onSelect,
}: {
  node: TreeNode
  depth: number
  selectedPath: string | null
  onToggle: (path: string) => void
  onSelect: (node: TreeNode) => void
}) {
  const isSelected = selectedPath === node.path
  return (
    <>
      <div
        className={`group flex items-center gap-1.5 py-[3px] cursor-pointer text-[11.5px] select-none transition-all duration-100 ${
          isSelected
            ? 'bg-purple-1/[0.08] text-text-1'
            : 'text-text-2 hover:bg-black/[0.03]'
        }`}
        style={{ paddingLeft: 12 + depth * 16, paddingRight: 8 }}
        tabIndex={0}
        role="treeitem"
        aria-expanded={node.isDirectory ? node.expanded : undefined}
        onClick={() => {
          if (node.isDirectory) onToggle(node.path)
          else onSelect(node)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            if (node.isDirectory) onToggle(node.path)
            else onSelect(node)
          }
        }}
      >
        {node.isDirectory ? (
          <span className="shrink-0 w-3 flex items-center justify-center">
            <ChevronIcon open={node.expanded} />
          </span>
        ) : (
          <span className="shrink-0 w-3" />
        )}
        <span className="shrink-0 flex items-center">
          {node.isDirectory ? <FolderIcon open={node.expanded} /> : fileIconSvg(node.name)}
        </span>
        <span className={`truncate ${node.isDirectory ? 'font-medium' : ''}`}>{node.name}</span>
        {/* Size / item count — always visible, right-aligned */}
        <span className="ml-auto text-[9px] text-text-3/40 tabular-nums shrink-0 pl-2">
          {node.isDirectory
            ? (node.childCount != null ? `${node.childCount}` : '')
            : formatSizeContext(node.size, node.name)
          }
        </span>
      </div>
      {node.isDirectory && node.expanded && node.children?.map(child => (
        <TreeItem
          key={child.path}
          node={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </>
  )
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function FilePathView() {
  const api = window.electronAPI

  // State
  const [rootPath, setRootPath] = useState('')
  const [rootName, setRootName] = useState('')
  const [tree, setTree] = useState<TreeNode[]>([])
  const [selectedFile, setSelectedFile] = useState<{ path: string; name: string; size?: number; modifiedAt?: string } | null>(null)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editBuffer, setEditBuffer] = useState('')
  const [saving, setSaving] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [treePanelWidth, setTreePanelWidth] = useState(() =>
    parseInt(localStorage.getItem('roca:filePathTreeWidth') || '240', 10)
  )
  const [terminalWidth, setTerminalWidth] = useState(() =>
    parseInt(localStorage.getItem('roca:filePathTermWidth') || '420', 10)
  )

  // Agent context
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [matchedAgent, setMatchedAgent] = useState<AgentInfo | null>(null)

  // Refs
  const termContainerRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<TerminalSession | null>(null)
  const termPtyId = useRef<string | null>(null)
  const isResizingTree = useRef(false)
  const isResizingTerm = useRef(false)
  const expandingPaths = useRef<Set<string>>(new Set())
  const treeRef = useRef<TreeNode[]>([])
  treeRef.current = tree

  // ── Persist panel widths across sessions ───────────────────────────────────
  useEffect(() => { localStorage.setItem('roca:filePathTreeWidth', String(treePanelWidth)) }, [treePanelWidth])
  useEffect(() => { localStorage.setItem('roca:filePathTermWidth', String(terminalWidth)) }, [terminalWidth])

  // ── Initialize root ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { projectRoot } = await api.filePathGetRoot()
      if (cancelled) return
      setRootPath(projectRoot)
      setRootName(projectRoot.split('/').pop() || 'project')
      const entries = await api.filePathListDir(projectRoot)
      if (cancelled) return
      setTree(entries.map(e => ({ ...e, children: undefined, loaded: false, expanded: false })))
    })()
    return () => { cancelled = true }
  }, [])

  // ── Load agents (once) ─────────────────────────────────────────────────────
  useEffect(() => {
    api.agentsList().then((list: any[]) => setAgents(list))
  }, [])

  // ── Poll agent status when context bar is visible ──────────────────────────
  useEffect(() => {
    if (!matchedAgent) return
    const poll = () => api.agentsList().then((list: any[]) => {
      setAgents(list)
      const refreshed = list.find((a: any) => a.label === matchedAgent.label)
      if (refreshed) setMatchedAgent(refreshed as AgentInfo)
    })
    poll() // fetch fresh status immediately on agent match
    const interval = setInterval(() => { if (!document.hidden) poll() }, 30000)
    return () => clearInterval(interval)
  }, [matchedAgent?.label])

  // ── Detect agent from selected file path ───────────────────────────────────
  useEffect(() => {
    if (!selectedFile) { setMatchedAgent(null); return }
    const fp = selectedFile.path.toLowerCase()
    const agentDirMatch = fp.match(/\/agents\/([^/]+)\//)
    if (agentDirMatch) {
      const dirName = agentDirMatch[1]
      const dirToAgent: Record<string, string> = {
        samson: 'Industry Prospecting', theseus: 'NAICS Discovery',
        athena: 'Company Evaluation', castor: 'Contact Enrichment',
        pollux: 'Contact QA', odysseus: 'Daily Report',
        hermes: 'Outreach Sync', argus: 'CRM Audit',
        charon: 'Re-Evaluation', atlas: 'Slack Bot', cape: 'Warm Intros',
      }
      const agentName = dirToAgent[dirName]
      if (agentName) {
        const match = agents.find(a => a.name === agentName)
        if (match) { setMatchedAgent(match); return }
      }
    }
    setMatchedAgent(null)
  }, [selectedFile?.path, agents])

  // ── Toggle directory expansion ─────────────────────────────────────────────
  const toggleDir = useCallback(async (dirPath: string) => {
    // Guard against concurrent toggles on the same path (prevents stale-closure overwrites)
    if (expandingPaths.current.has(dirPath)) return
    expandingPaths.current.add(dirPath)
    try {
      const toggle = async (nodes: TreeNode[]): Promise<TreeNode[]> => {
        const result: TreeNode[] = []
        for (const node of nodes) {
          if (node.path === dirPath) {
            if (!node.loaded) {
              const children = await api.filePathListDir(dirPath)
              result.push({
                ...node, expanded: true, loaded: true,
                children: children.map(e => ({ ...e, children: undefined, loaded: false, expanded: false })),
              })
            } else {
              result.push({ ...node, expanded: !node.expanded })
            }
          } else if (node.children) {
            result.push({ ...node, children: await toggle(node.children) })
          } else {
            result.push(node)
          }
        }
        return result
      }
      setTree(await toggle(treeRef.current))
    } finally {
      expandingPaths.current.delete(dirPath)
    }
  }, [])

  // ── Select file ────────────────────────────────────────────────────────────
  const selectFile = useCallback(async (node: TreeNode) => {
    setSelectedFile({ path: node.path, name: node.name, size: node.size, modifiedAt: node.modifiedAt })
    setEditing(false)
    setFileLoading(true)
    try {
      const result = await api.filePathReadFile(node.path)
      if (result.ok) {
        setFileContent(result.content)
        setFileError(null)
      } else {
        setFileContent(null)
        setFileError('Could not read file')
      }
    } catch (e) {
      setFileContent(null)
      setFileError('Could not read file')
      console.error(e)
    } finally {
      setFileLoading(false)
    }
  }, [])

  // ── Save file ──────────────────────────────────────────────────────────────
  const saveFile = useCallback(async () => {
    if (!selectedFile) return
    setSaving(true)
    try {
      await api.filePathSaveFile(selectedFile.path, editBuffer)
      setFileContent(editBuffer)
      setEditing(false)
    } catch (e) {
      console.error(e)
    } finally {
      setSaving(false)
    }
  }, [selectedFile, editBuffer])

  // ── Terminal lifecycle ─────────────────────────────────────────────────────
  // Use a callback ref so we attach the terminal the instant the DOM node mounts
  const termCallbackRef = useCallback((node: HTMLDivElement | null) => {
    // Store in the regular ref too so other code can access it
    (termContainerRef as React.MutableRefObject<HTMLDivElement | null>).current = node

    // If unmounting or already have a session, bail
    if (!node || sessionRef.current) return

    const session = new TerminalSession(node)
    sessionRef.current = session

    ;(async () => {
      const cwd = selectedFile
        ? selectedFile.path.substring(0, selectedFile.path.lastIndexOf('/'))
        : rootPath || undefined
      const result = await api.startPty('filepath-terminal', cwd)
      if (!result.ok) return
      termPtyId.current = result.id

      if (result.savedScrollback) session.terminal.write(result.savedScrollback)

      const cleanupData = api.onPtyData(result.id, (data: string) => session.terminal.write(data))
      const cleanupExit = api.onPtyExit(result.id, () => {})

      session.terminal.onData((data: string) => api.writePty(result.id, data))
      session.onResize((cols, rows) => api.resizePty(result.id, cols, rows))

      session._cleanup = () => {
        cleanupData()
        cleanupExit()
      }
    })()
  }, [rootPath, selectedFile?.path])

  // Clean up terminal when panel closes
  useEffect(() => {
    if (!terminalOpen && sessionRef.current) {
      if (sessionRef.current._cleanup) sessionRef.current._cleanup()
      if (termPtyId.current) api.killPty(termPtyId.current)
      sessionRef.current.dispose()
      sessionRef.current = null
    }
  }, [terminalOpen])

  // Guarantee PTY cleanup on unmount even if terminal was open (empty deps = runs only on unmount)
  useEffect(() => {
    return () => {
      if (sessionRef.current) {
        if (sessionRef.current._cleanup) sessionRef.current._cleanup()
        if (termPtyId.current) api.killPty(termPtyId.current)
        sessionRef.current.dispose()
        sessionRef.current = null
      }
    }
  }, [])

  // ── Resize: tree panel ─────────────────────────────────────────────────────
  const handleTreeResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizingTree.current = true
    const startX = e.clientX
    const startWidth = treePanelWidth
    const onMouseMove = (e: MouseEvent) => {
      if (!isResizingTree.current) return
      setTreePanelWidth(Math.min(400, Math.max(140, startWidth + (e.clientX - startX))))
    }
    const onMouseUp = () => {
      isResizingTree.current = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [treePanelWidth])

  // ── Resize: terminal panel ─────────────────────────────────────────────────
  const handleTermResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizingTerm.current = true
    const startX = e.clientX
    const startWidth = terminalWidth
    const onMouseMove = (e: MouseEvent) => {
      if (!isResizingTerm.current) return
      setTerminalWidth(Math.min(800, Math.max(280, startWidth - (e.clientX - startX))))
    }
    const onMouseUp = () => {
      isResizingTerm.current = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [terminalWidth])

  // ── Determine file rendering mode ──────────────────────────────────────────
  const isMarkdown = selectedFile && /\.(md|skill)$/i.test(selectedFile.name)

  // ── Breadcrumb path ────────────────────────────────────────────────────────
  const breadcrumbParts = selectedFile
    ? selectedFile.path.replace(rootPath + '/', '').split('/')
    : []

  // ── File metadata line ─────────────────────────────────────────────────────
  const fileMeta = selectedFile ? [
    formatSizeContext(selectedFile.size, selectedFile.name),
    selectedFile.size != null && isTextFile(selectedFile.name) ? `${(selectedFile.size / 1024).toFixed(1)}KB raw` : '',
    formatDate(selectedFile.modifiedAt),
  ].filter(Boolean).join('  ·  ') : ''

  return (
    <div className="flex flex-col h-full w-full bg-surface-0">
      {/* Agent context bar */}
      {matchedAgent && (
        <div className="flex items-center gap-3 px-5 py-1.5 border-b border-black/[0.06] bg-black/[0.015]">
          <div className="flex items-center gap-2">
            <span className={`w-[6px] h-[6px] rounded-full ${matchedAgent.running ? 'bg-green-1 shadow-[0_0_4px_rgba(34,197,94,0.4)]' : 'bg-surface-4'}`} />
            <span className="text-[11px] font-semibold text-text-1 tracking-tight">{matchedAgent.name}</span>
            <span className={`text-[9.5px] font-medium px-1.5 py-[1px] rounded-full ${
              matchedAgent.running ? 'bg-green-2 text-green-1' : 'bg-black/[0.04] text-text-3'
            }`}>
              {matchedAgent.running ? 'Running' : 'Stopped'}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {matchedAgent.running ? (
              <button onClick={() => api.agentsStop(matchedAgent.label)}
                className="px-2 py-[2px] rounded text-[9.5px] font-medium text-red-1/80 hover:text-red-1 hover:bg-red-2 cursor-pointer transition-all">
                Stop
              </button>
            ) : (
              <button onClick={() => api.agentsStart(matchedAgent.label)}
                className="px-2 py-[2px] rounded text-[9.5px] font-medium text-green-1/80 hover:text-green-1 hover:bg-green-2 cursor-pointer transition-all">
                Start
              </button>
            )}
            <button onClick={() => api.agentsOpenOutput(matchedAgent.label)}
              className="px-2 py-[2px] rounded text-[9.5px] font-medium text-text-3 hover:text-text-1 hover:bg-black/[0.04] cursor-pointer transition-all">
              Logs
            </button>
          </div>
        </div>
      )}

      {/* ── Three-column layout ──────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Column 1: Directory Tree ────────────────────────────────────── */}
        <div className="shrink-0 flex flex-col overflow-hidden bg-black/[0.015]" style={{ width: treePanelWidth }}>
          {/* Root label + terminal toggle */}
          <div className="px-3 py-2 flex items-center gap-1.5">
            <svg className="w-3 h-3 text-text-3/40 shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
            </svg>
            <span className="text-[10.5px] font-semibold text-text-2 tracking-wide uppercase truncate">{rootName}</span>
            <button
              onClick={() => setTerminalOpen(prev => !prev)}
              className={`ml-auto p-1 rounded transition-all shrink-0 ${
                terminalOpen ? 'bg-purple-1/[0.1] text-purple-1' : 'text-text-3/40 hover:text-text-2 hover:bg-black/[0.04]'
              }`}
              title="Toggle terminal"
            >
              <TerminalIcon className="w-3.5 h-3.5" />
            </button>
          </div>
          {/* Tree */}
          <div className="flex-1 overflow-y-auto">
            {tree.map(node => (
              <TreeItem
                key={node.path}
                node={node}
                depth={0}
                selectedPath={selectedFile?.path ?? null}
                onToggle={toggleDir}
                onSelect={selectFile}
              />
            ))}
          </div>
        </div>

        {/* Tree resize handle */}
        <div
          className="w-[4px] shrink-0 cursor-col-resize bg-black/[0.06] hover:bg-purple-1/30 active:bg-purple-1/40 transition-colors"
          onMouseDown={handleTreeResize}
        />

        {/* ── Column 2: File Viewer ──────────────────────────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {selectedFile ? (
            <>
              {/* File header bar */}
              <div className="flex items-center gap-2 px-5 py-2 border-b border-black/[0.06] shrink-0">
                {/* Breadcrumb + meta */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-0.5">
                    {breadcrumbParts.map((part, i) => (
                      <React.Fragment key={i}>
                        {i > 0 && <span className="text-[10px] text-text-3/30 mx-0.5">/</span>}
                        <span className={`text-[11px] font-mono ${
                          i === breadcrumbParts.length - 1 ? 'text-text-1 font-medium' : 'text-text-3'
                        }`}>
                          {part}
                        </span>
                      </React.Fragment>
                    ))}
                  </div>
                  {fileMeta && (
                    <div className="text-[9.5px] text-text-3/50 mt-0.5 tabular-nums">{fileMeta}</div>
                  )}
                </div>
                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
                  {!editing ? (
                    <button
                      onClick={() => { setEditing(true); setEditBuffer(fileContent ?? '') }}
                      className="px-2.5 py-[3px] rounded-md text-[10px] font-medium text-text-3 hover:text-text-1 hover:bg-black/[0.04] transition-all"
                    >
                      Edit
                    </button>
                  ) : (
                    <>
                      <button onClick={() => setEditing(false)}
                        className="px-2.5 py-[3px] rounded-md text-[10px] font-medium text-text-3 hover:text-text-1 transition-all">
                        Cancel
                      </button>
                      <button onClick={saveFile} disabled={saving}
                        className="px-3 py-[3px] rounded-md text-[10px] font-semibold bg-purple-1 text-white hover:bg-purple-1/90 transition-all disabled:opacity-50">
                        {saving ? 'Saving...' : 'Save'}
                      </button>
                    </>
                  )}
                  <div className="w-px h-3 bg-black/[0.08] mx-1" />
                  <button
                    onClick={() => setTerminalOpen(prev => !prev)}
                    className={`flex items-center gap-1 px-2.5 py-[3px] rounded-md text-[10px] font-medium transition-all ${
                      terminalOpen ? 'bg-purple-1/[0.08] text-purple-1' : 'text-text-3 hover:text-text-1 hover:bg-black/[0.04]'
                    }`}
                  >
                    <TerminalIcon />
                    Terminal
                  </button>
                </div>
              </div>

              {/* File content */}
              <div className="flex-1 overflow-auto">
                {fileLoading ? (
                  <div className="flex items-center justify-center h-32">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full border-2 border-purple-1/20 border-t-purple-1/60 animate-spin" />
                      <span className="text-[11px] text-text-3">Loading...</span>
                    </div>
                  </div>
                ) : fileError ? (
                  <div className="flex-1 flex items-center justify-center h-32">
                    <div className="text-center">
                      <p className="text-[12px] font-medium text-red-1 mb-1">{fileError}</p>
                      <button
                        onClick={() => selectedFile && selectFile({ path: selectedFile.path, name: selectedFile.name, size: selectedFile.size, modifiedAt: selectedFile.modifiedAt, isDirectory: false, loaded: true, expanded: false })}
                        className="text-[11px] text-text-3 hover:text-text-1 transition-colors cursor-pointer"
                      >
                        Retry
                      </button>
                    </div>
                  </div>
                ) : editing ? (
                  <textarea
                    value={editBuffer}
                    onChange={e => setEditBuffer(e.target.value)}
                    className="w-full h-full p-5 text-[12.5px] font-mono bg-surface-0 text-text-1 resize-none outline-none leading-[1.7]"
                    spellCheck={false}
                    autoFocus
                  />
                ) : isMarkdown && fileContent ? (
                  <div
                    className="p-6 text-[13px] leading-relaxed text-text-1 max-w-[780px]
                      [&_h1]:text-[20px] [&_h1]:font-bold [&_h1]:mb-3 [&_h1]:mt-6 [&_h1]:text-text-1 [&_h1]:tracking-tight
                      [&_h2]:text-[16px] [&_h2]:font-semibold [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-text-1
                      [&_h3]:text-[13.5px] [&_h3]:font-semibold [&_h3]:mb-1.5 [&_h3]:mt-4 [&_h3]:text-text-1
                      [&_p]:my-2 [&_p]:leading-[1.7]
                      [&_pre]:bg-black/[0.03] [&_pre]:rounded-lg [&_pre]:p-4 [&_pre]:text-[12px] [&_pre]:overflow-x-auto [&_pre]:my-3 [&_pre]:border [&_pre]:border-black/[0.04]
                      [&_code]:bg-black/[0.05] [&_code]:rounded [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[11px] [&_code]:font-mono [&_code]:text-purple-1/80
                      [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-text-1
                      [&_a]:text-purple-1 [&_a]:underline [&_a]:decoration-purple-1/30 [&_a]:underline-offset-2 [&_a]:hover:decoration-purple-1
                      [&_blockquote]:border-l-2 [&_blockquote]:border-purple-1/20 [&_blockquote]:pl-4 [&_blockquote]:text-text-2 [&_blockquote]:italic
                      [&_hr]:border-black/[0.06] [&_hr]:my-6
                      [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-2
                      [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-2
                      [&_li]:my-1 [&_li]:leading-[1.6]
                      [&_table]:text-[11.5px] [&_table]:my-3 [&_table]:w-full
                      [&_th]:text-left [&_th]:pr-4 [&_th]:pb-2 [&_th]:font-semibold [&_th]:text-text-2 [&_th]:border-b [&_th]:border-black/[0.08]
                      [&_td]:pr-4 [&_td]:py-1.5 [&_td]:border-b [&_td]:border-black/[0.04]
                      [&_strong]:font-semibold"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(fileContent) }}
                  />
                ) : (
                  <pre className="p-5 text-[12.5px] font-mono text-text-1 whitespace-pre-wrap break-words leading-[1.7]">
                    {fileContent}
                  </pre>
                )}
              </div>
            </>
          ) : (
            /* Empty state — with terminal button */
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center select-none">
                <div className="w-14 h-14 rounded-2xl bg-black/[0.03] flex items-center justify-center mx-auto mb-4">
                  <svg className="w-6 h-6 text-text-3/20" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                </div>
                <p className="text-[12px] font-medium text-text-2 mb-1">Select a file</p>
                <p className="text-[11px] text-text-3/60 mb-4">Browse the tree on the left</p>
                <button
                  onClick={() => setTerminalOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10.5px] font-medium bg-black/[0.04] text-text-2 hover:bg-black/[0.07] hover:text-text-1 transition-all"
                >
                  <TerminalIcon className="w-3.5 h-3.5" />
                  Open Terminal
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── Column 3: Terminal (right side) ─────────────────────────────── */}
        {terminalOpen && (
          <>
            <div
              className="w-[4px] shrink-0 cursor-col-resize bg-black/[0.06] hover:bg-purple-1/30 active:bg-purple-1/40 transition-colors"
              onMouseDown={handleTermResize}
            />
            <div className="shrink-0 flex flex-col bg-surface-0 overflow-hidden" style={{ width: terminalWidth }}>
              <div className="flex items-center px-3 py-1.5 border-b border-black/[0.06] bg-black/[0.015]">
                <div className="flex items-center gap-1.5">
                  <TerminalIcon className="w-3 h-3 text-text-3/40" />
                  <span className="text-[10px] font-semibold text-text-3 tracking-wide uppercase">Terminal</span>
                </div>
                <button
                  onClick={() => setTerminalOpen(false)}
                  className="ml-auto p-1.5 rounded hover:bg-black/[0.06] text-text-3/40 hover:text-text-2 transition-colors cursor-pointer"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div ref={termCallbackRef} className="flex-1" />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
