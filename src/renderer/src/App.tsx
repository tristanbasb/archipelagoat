import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react'

// Temporary shell: Task 23 replaces this file with the real router. Until then it mounts the
// dev gallery at #/dev/gallery, for unpackaged builds only.
const Gallery = lazy(() => import('./features/dev/Gallery').then((module) => ({ default: module.Gallery })))

function subscribeHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

function useHash(): string {
  return useSyncExternalStore(subscribeHash, () => window.location.hash)
}

export function App(): React.JSX.Element {
  const hash = useHash()
  const [devToolsAllowed, setDevToolsAllowed] = useState(false)

  useEffect(() => {
    window.goat
      .invoke('app:getInfo')
      .then((info) => setDevToolsAllowed(!info.isPackaged))
      .catch(() => setDevToolsAllowed(false))
  }, [])

  if (hash === '#/dev/gallery' && devToolsAllowed) {
    return (
      <Suspense fallback={null}>
        <Gallery />
      </Suspense>
    )
  }
  return <h1>ArchipelaGOAT</h1>
}
