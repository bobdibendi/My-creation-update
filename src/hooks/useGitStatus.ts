import { useCallback, useEffect, useState } from 'react'
import type { GitRepositoryInfo } from '../shared/types'

export function useGitStatus(folderPath: string | null) {
  const [gitStatus, setGitStatus] = useState('')
  const [repository, setRepository] = useState<GitRepositoryInfo | null>(null)

  const refreshGitStatus = useCallback(async () => {
    const bridge = window.electronAPI
    if (!bridge || !folderPath) {
      setGitStatus('')
      setRepository(null)
      return
    }
    try {
      // A folder outside a repository would otherwise report an unrelated
      // ancestor repository, so resolve ownership first.
      const info = await bridge.git.root(folderPath)
      setRepository(info)
      setGitStatus(info ? await bridge.git.status(folderPath) : '')
    } catch {
      setGitStatus('')
      setRepository(null)
    }
  }, [folderPath])

  useEffect(() => {
    void refreshGitStatus()
  }, [refreshGitStatus])

  return { gitStatus, repository, refreshGitStatus }
}
