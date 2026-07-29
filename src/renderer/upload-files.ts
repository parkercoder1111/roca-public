/** Upload multiple files to a task in parallel. Returns upload results. */
export async function uploadFiles(taskId: number, files: File[]) {
  const results = await Promise.allSettled(
    files.map(async (file) => {
      const arrayBuf = await file.arrayBuffer()
      return window.electronAPI.uploadFile(taskId, {
        buffer: new Uint8Array(arrayBuf),
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
      })
    })
  )
  const failures = results.filter(r => r.status === 'rejected')
  if (failures.length) {
    console.error(`[uploadFiles] ${failures.length}/${files.length} uploads failed`,
      failures.map(r => (r as PromiseRejectedResult).reason))
  }
  return results
    .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter(v => v.ok)
}
