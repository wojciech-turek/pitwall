import { useEffect, useState } from 'react'
import { configureParking } from '../terminal/termCache'

export interface AppInfo { version: string; dev: boolean; updateFeed: boolean; parkAfterMs: number }

let cached: Promise<AppInfo> | null = null
const load = (): Promise<AppInfo> => (cached ??= window.pitwall.appInfo().then((i) => { configureParking(i.parkAfterMs); return i }))

/** Build version and dev-ness (decided in main); null until it arrives. */
export function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    let live = true
    void load().then((i) => { if (live) setInfo(i) }).catch(() => { cached = null })
    return () => { live = false }
  }, [])
  return info
}
