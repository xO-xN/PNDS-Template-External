// Project-side protocol wiring. App owns the UI, durable records and common clock.
import { createRecordingAdapter } from '../recording/adapter.cjs'

export function createPerformanceRecording({
  performance,
  performerLabel,
  onMode,
}) {
  if (typeof performerLabel !== 'string' || !performerLabel.trim())
    throw new Error('Missing recording performer label')
  const workHooks = ['applyWork', 'restoreWork', 'releaseWork']
  if (
    workHooks.some(key => performance[key] !== undefined) &&
    workHooks.some(key => typeof performance[key] !== 'function')
  )
    throw new Error('Incomplete work recording callbacks')
  if (
    performance.releasePlaybackWork !== undefined &&
    typeof performance.releasePlaybackWork !== 'function'
  )
    throw new Error('Invalid work playback release callback')
  const livePlayback =
    !performance.applyWork || Boolean(performance.releasePlaybackWork)
  const inputSnapshot = () => performance.snapshotInput()
  function workCall(operation) {
    try {
      return operation()
    } catch (error) {
      adapter.reportFault(error)
      throw error
    }
  }
  function applyBusiness(
    sourceId,
    kind,
    payload,
    atMs = null,
    performerId = sourceId
  ) {
    return workCall(() => {
      if (kind === 'input') {
        if (!performance.applyEvent(sourceId, payload))
          throw new Error('Invalid recorded input')
      } else if (kind === 'leave' || kind === 'release')
        performance.release(sourceId)
      return performance.applyWork?.({
        sourceId,
        performerId,
        kind,
        payload,
        atMs,
      })
    })
  }
  const live = new Set()
  const replay = new Map()
  const seeds = new Map()
  let resetEpoch = 0,
    lastMode = null,
    lastReset = 0
  let restoringHeld = [],
    pendingReleased = []
  function clearContacts(sources = new Set([...live, ...replay.values()])) {
    let failure = null
    for (const source of sources) {
      try {
        performance.release(source)
      } catch (error) {
        failure ??= error
      }
    }
    if (failure) throw failure
  }
  function rememberReleased(performers) {
    const bySource = new Map(
      pendingReleased.map(({ performerId, ids }) => [performerId, new Set(ids)])
    )
    for (const performer of performers) {
      const ids = bySource.get(performer.id) ?? new Set()
      for (const contact of performer.contacts) ids.add(contact.id)
      bySource.set(performer.id, ids)
    }
    pendingReleased = [...bySource].map(([performerId, ids]) => ({
      performerId,
      ids: [...ids],
    }))
  }
  function release() {
    let snapshotError = null
    try {
      rememberReleased([
        ...inputSnapshot().performers.filter(performer =>
          live.has(performer.id)
        ),
        ...restoringHeld,
      ])
    } catch (error) {
      snapshotError = error
    }
    restoringHeld = []
    try {
      performance.releaseWork?.()
    } finally {
      try {
        clearContacts()
      } finally {
        replay.clear()
        seeds.clear()
        resetEpoch++
      }
    }
    if (snapshotError) throw snapshotError
  }
  function releasePlayback() {
    try {
      performance.releasePlaybackWork?.([...replay.values()])
    } finally {
      clearContacts(replay.values())
    }
    replay.clear()
  }
  function restoreContacts(source, contacts, recordedId = null) {
    if (!Array.isArray(contacts)) throw new Error('Invalid recorded contacts')
    const events = []
    for (const contact of contacts) {
      const event = { ...contact, kind: 'contact', phase: 'start' }
      applyBusiness(
        source,
        'input',
        event,
        recordedId === null ? null : 0,
        recordedId ?? source
      )
      events.push({ kind: 'input', payload: event })
    }
    return events
  }
  function restore(initialState, performers) {
    if (
      !initialState ||
      !Array.isArray(initialState.performers) ||
      !Array.isArray(performers)
    )
      throw new Error('Invalid Blank recording state')
    // Restore the shared score while retaining real held input. Only an
    // overdub records the restored live contacts as time-zero seeds.
    const currentState = performance.snapshot()
    const overdub = adapter.mode === 'overdub'
    const keepLive = overdub || livePlayback
    const liveIds = keepLive ? [...live] : []
    const held = keepLive
      ? currentState.performers.filter(performer => live.has(performer.id))
      : []
    restoringHeld = held
    if (!keepLive)
      rememberReleased(
        inputSnapshot().performers.filter(performer => live.has(performer.id))
      )
    clearContacts()
    replay.clear()
    seeds.clear()
    for (const performer of performers) {
      if (
        !performer ||
        typeof performer.id !== 'string' ||
        !performer.id ||
        replay.has(performer.id)
      )
        throw new Error('Invalid recorded performer')
      replay.set(performer.id, `replay:${performer.id}`)
    }
    performance.releaseWork?.()
    performance.restoreWork?.(initialState, performers, {
      liveIds,
      currentState,
    })
    for (const performer of initialState.performers) {
      const source = replay.get(performer.id)
      // Native rerecord/delete retains initialState while omitting that pass.
      if (source) restoreContacts(source, performer.contacts, performer.id)
    }
    for (const performer of held) {
      const events = restoreContacts(performer.id, performer.contacts)
      if (overdub) seeds.set(performer.id, events)
    }
    restoringHeld = []
  }
  function apply(event) {
    if (event.performerId === null) {
      if (event.kind !== 'conductor' || !performance.applyWork)
        throw new Error('Unknown recorded conductor event')
      applyBusiness(null, event.kind, event.payload, event.atMs, null)
      return
    }
    const source = replay.get(event.performerId)
    if (!source) throw new Error('Unknown recorded performer')
    if (
      !['input', 'action', 'leave', 'release', 'join', 'selection'].includes(
        event.kind
      )
    )
      throw new Error('Unknown recorded event')
    applyBusiness(
      source,
      event.kind,
      event.payload,
      event.atMs,
      event.performerId
    )
  }
  const adapter = createRecordingAdapter({
    adapterId: 'pnds-blank-input-v1',
    snapshot: () => performance.snapshot(),
    restore,
    apply,
    release,
    ...(livePlayback ? { releasePlayback } : {}),
    ...(performance.advanceWork
      ? { advance: elapsedMs => performance.advanceWork(elapsedMs) }
      : {}),
    seed(sourceId) {
      const held = seeds.get(sourceId) ?? []
      seeds.delete(sourceId)
      return held
    },
  })
  function state() {
    return {
      mode: adapter.mode,
      resetEpoch,
      liveInputAllowed: adapter.mode !== 'playback' || livePlayback,
    }
  }
  return {
    join(id) {
      live.add(id)
      const selection = workCall(() => performance.selectionFor?.(id) ?? null)
      applyBusiness(id, 'join', { label: performerLabel, selection })
      adapter.register(id, performerLabel, selection)
    },
    leave(id) {
      if (!live.delete(id)) return
      try {
        applyBusiness(id, 'leave', null)
      } finally {
        seeds.delete(id)
        adapter.unregister(id)
      }
    },
    input(id, payload) {
      if (adapter.fault || !live.has(id) || !adapter.admitted(id)) return false
      const event = performance.prepareInput(id, payload)
      if (!event || !adapter.capture(id, 'input', event)) return false
      applyBusiness(id, 'input', event)
      return true
    },
    action(id, payload) {
      if (adapter.fault || !live.has(id) || !adapter.admitted(id)) return false
      const event = performance.prepareAction?.(payload)
      if (!event || !adapter.capture(id, 'action', event)) return false
      applyBusiness(id, 'action', event)
      if (performance.selectionFor)
        adapter.selection(
          id,
          workCall(() => performance.selectionFor(id))
        )
      return true
    },
    conduct(payload) {
      if (adapter.fault || !adapter.conductorAllowed) return false
      const event = performance.prepareConductor?.(payload)
      if (!event || !adapter.capture(null, 'conductor', event)) return false
      applyBusiness(null, 'conductor', event)
      return true
    },
    get conductorAllowed() {
      return adapter.conductorAllowed
    },
    get mode() {
      return adapter.mode
    },
    get state() {
      return state()
    },
    async handle(request, response) {
      try {
        if (
          new URL(request.url, 'http://localhost').pathname !==
          '/__pnds/recording'
        )
          return false
      } catch {
        response.writeHead(400)
        response.end()
        return true
      }
      const handled = await adapter.handle(request, response)
      if (handled && (adapter.mode !== lastMode || resetEpoch !== lastReset)) {
        lastMode = adapter.mode
        lastReset = resetEpoch
        onMode?.({ ...state(), released: pendingReleased })
        pendingReleased = []
      }
      return handled
    },
    close: release,
  }
}
