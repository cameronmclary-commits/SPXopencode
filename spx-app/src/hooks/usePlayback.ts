import { useState, useEffect, useRef, useCallback } from 'react'
import type { ChainSnapshot } from '../types'

export type PlaybackSpeed = 0.5 | 1 | 2 | 5 | 10 | 25

export interface PlaybackState {
  current: ChainSnapshot | null
  index: number
  total: number
  progress: number
  playing: boolean
  speed: PlaybackSpeed
  atStart: boolean
  atEnd: boolean
}

export interface PlaybackActions {
  play: () => void
  pause: () => void
  toggle: () => void
  stepForward: () => void
  stepBack: () => void
  seek: (index: number) => void
  seekToStart: () => void
  seekToEnd: () => void
  setSpeed: (speed: PlaybackSpeed) => void
}

const SPEEDS: PlaybackSpeed[] = [0.5, 1, 2, 5, 10, 25]

export function usePlayback(snapshots: ChainSnapshot[]): PlaybackState & PlaybackActions {
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<PlaybackSpeed>(1)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const total = snapshots.length

  const current = total > 0 ? snapshots[index] ?? null : null
  const progress = total > 1 ? index / (total - 1) : 0
  const atStart = index === 0
  const atEnd = index >= total - 1

  const pause = useCallback(() => {
    setPlaying(false)
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const play = useCallback(() => {
    if (atEnd) {
      setIndex(0)
    }
    setPlaying(true)
  }, [atEnd])

  const toggle = useCallback(() => {
    if (playing) pause()
    else play()
  }, [playing, pause, play])

  const stepForward = useCallback(() => {
    pause()
    setIndex(i => Math.min(i + 1, total - 1))
  }, [pause, total])

  const stepBack = useCallback(() => {
    pause()
    setIndex(i => Math.max(i - 1, 0))
  }, [pause])

  const seek = useCallback((idx: number) => {
    setIndex(Math.max(0, Math.min(idx, total - 1)))
  }, [total])

  const seekToStart = useCallback(() => {
    pause()
    setIndex(0)
  }, [pause])

  const seekToEnd = useCallback(() => {
    pause()
    setIndex(total - 1)
  }, [pause, total])

  const cycleSpeed = useCallback(() => {
    setSpeed(prev => {
      const currentIdx = SPEEDS.indexOf(prev)
      return SPEEDS[(currentIdx + 1) % SPEEDS.length]
    })
  }, [])

  useEffect(() => {
    if (!playing) {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
      return
    }

    const intervalMs = 1000 / speed
    timerRef.current = setInterval(() => {
      setIndex(prev => {
        if (prev >= total - 1) {
          setPlaying(false)
          return total - 1
        }
        return prev + 1
      })
    }, intervalMs)

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [playing, speed, total])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      switch (e.key) {
        case ' ':
          e.preventDefault()
          toggle()
          break
        case 'ArrowRight':
          e.preventDefault()
          stepForward()
          break
        case 'ArrowLeft':
          e.preventDefault()
          stepBack()
          break
        case 'ArrowUp':
          e.preventDefault()
          setSpeed(prev => {
            const idx = SPEEDS.indexOf(prev)
            return SPEEDS[Math.min(idx + 1, SPEEDS.length - 1)]
          })
          break
        case 'ArrowDown':
          e.preventDefault()
          setSpeed(prev => {
            const idx = SPEEDS.indexOf(prev)
            return SPEEDS[Math.max(idx - 1, 0)]
          })
          break
        case 'Home':
          e.preventDefault()
          seekToStart()
          break
        case 'End':
          e.preventDefault()
          seekToEnd()
          break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [toggle, stepForward, stepBack, seekToStart, seekToEnd])

  return {
    current,
    index,
    total,
    progress,
    playing,
    speed,
    atStart,
    atEnd,
    play,
    pause,
    toggle,
    stepForward,
    stepBack,
    seek,
    seekToStart,
    seekToEnd,
    setSpeed,
  }
}
