(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CoconaraOutbox = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const STATES = new Set(['queued', 'sending', 'uncertain', 'confirmed', 'cancelled']);
  const PENDING = new Set(['queued', 'sending', 'uncertain']);
  const TERMINAL = new Set(['uncertain', 'confirmed', 'cancelled']);
  let sequence = 0;

  function failure(code, message, cause) {
    const error = new Error(message);
    error.code = code;
    if (cause) error.cause = cause;
    return error;
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
    return JSON.stringify(value);
  }
  function result(task) { return {id: task.id, status: task.status, results: clone(task.results || []), duplicateOf: task.duplicateOf || null}; }
  function ordinal(task) { return Number.isFinite(task.ordinal) ? task.ordinal : task.createdAt; }
  function compareTasks(a, b) {
    return ordinal(a) - ordinal(b) || (a.producer === b.producer ? (a.sequence || 0) - (b.sequence || 0) : 0) || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
  }

  function create(options) {
    if (!options || !options.storage || typeof options.scope !== 'string' || !options.scope || typeof options.day !== 'function' || typeof options.send !== 'function') {
      throw failure('INVALID_OPTIONS', '저장소, 연결 주소, 날짜와 전송 함수가 필요합니다.');
    }
    const storage = options.storage;
    const scope = options.scope;
    const prefix = 'coconara:outbox:v1:' + encodeURIComponent(scope) + ':';
    const lockName = prefix + 'writer';
    const locks = options.lock === undefined ? (root.navigator && root.navigator.locks) : options.lock;
    const lockSupported = !!(locks && typeof locks.request === 'function');
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const canSend = typeof options.canSend === 'function' ? options.canSend : () => true;
    const producer = Math.random().toString(36).slice(2) + '-' + (++sequence).toString(36);
    let producerSequence = 0;
    const waiters = new Map();
    let disposed = false, activeFlush = null, flushAgain = false, errorState = null;
    let flushing = false;

    function currentDay() {
      const day = String(options.day());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw failure('INVALID_DAY', '작업 날짜를 확인해 주세요.');
      return day;
    }
    function storageFailure(error) {
      return error && ['STORAGE_ERROR', 'CORRUPT_STORAGE'].includes(error.code) ? error : failure('STORAGE_ERROR', '작업을 이 기기에 저장하지 못했습니다. 저장 공간과 브라우저 설정을 확인해 주세요.', error);
    }
    function readTasks() {
      try {
        const keys = [];
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (typeof key === 'string' && key.startsWith(prefix)) keys.push(key);
        }
        const tasks = [];
        for (const key of keys) {
          const raw = storage.getItem(key);
          if (raw === null) continue;
          let task;
          try { task = JSON.parse(raw); } catch (error) { throw failure('CORRUPT_STORAGE', '보관된 작업 기록을 읽지 못했습니다. 기록을 보존한 채 확인이 필요합니다.', error); }
          if (!task || task.version !== 1 || task.scope !== scope || typeof task.id !== 'string' || key !== prefix + task.id || !STATES.has(task.status) || !Array.isArray(task.steps) || !task.steps.length || task.steps.length > 64 || !task.steps.every(step => step && typeof step === 'object' && !Array.isArray(step) && typeof step.action === 'string' && step.action) || !Array.isArray(task.results) || !Number.isInteger(task.cursor) || task.cursor < 0 || task.cursor > task.steps.length || task.results.length !== task.cursor || (PENDING.has(task.status) && task.cursor === task.steps.length) || (task.status === 'confirmed' && task.cursor !== task.steps.length) || typeof task.entity !== 'string' || typeof task.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(task.day) || !Number.isFinite(task.createdAt) || typeof task.fingerprint !== 'string' || task.fingerprint !== stable({entity: task.entity, steps: task.steps, day: task.day})) {
            throw failure('CORRUPT_STORAGE', '보관된 작업 기록 형식이 올바르지 않습니다. 자동 처리를 중단했습니다.');
          }
          tasks.push(task);
        }
        return tasks.sort(compareTasks);
      } catch (error) { throw storageFailure(error); }
    }
    function persist(task) {
      try {
        const raw = JSON.stringify(task);
        storage.setItem(prefix + task.id, raw);
        // Some environments silently reject a write. Never dispatch without read-back.
        if (storage.getItem(prefix + task.id) !== raw) throw new Error('write verification failed');
      } catch (error) { throw storageFailure(error); }
    }
    function remove(task) {
      try {
        storage.removeItem(prefix + task.id);
        if (storage.getItem(prefix + task.id) !== null) throw new Error('removal verification failed');
      } catch (error) { throw storageFailure(error); }
    }
    function settle(tasks) {
      for (const task of tasks) {
        const waiter = waiters.get(task.id);
        if (waiter && TERMINAL.has(task.status)) { waiter.resolve(result(task)); waiters.delete(task.id); }
      }
    }
    function notify() {
      let tasks;
      try { tasks = readTasks(); settle(tasks); }
      catch (error) { errorState = {code: error.code, message: error.message}; tasks = null; }
      if (typeof options.onChange === 'function') {
        try { options.onChange(tasks, diagnostics()); } catch (_) { /* A view error must not alter durable work. */ }
      }
    }
    function noteError(error) { errorState = {code: error.code || 'OUTBOX_ERROR', message: error.message || '작업 기록을 확인해 주세요.'}; notify(); }
    function diagnostics() { return {lockSupported, flushing, error: errorState ? {...errorState} : null, blockedReason: !lockSupported ? 'lock-unavailable' : null}; }
    function awaitTask(task) {
      if (TERMINAL.has(task.status)) return Promise.resolve(result(task));
      if (!waiters.has(task.id)) {
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        waiters.set(task.id, {promise, resolve});
      }
      return waiters.get(task.id).promise;
    }
    function scheduleFlush() {
      if (disposed) return;
      Promise.resolve().then(() => flush()).catch(noteError);
    }
    function enqueue(steps, metadata) {
      if (disposed) throw failure('DISPOSED', '종료된 작업 저장소입니다.');
      metadata = metadata || {};
      let safeSteps, effects;
      try { safeSteps = clone(steps); effects = clone(metadata.effects === undefined ? [] : metadata.effects); }
      catch (error) { throw failure('INVALID_TASK', '저장할 작업 형식을 확인해 주세요.', error); }
      if (!Array.isArray(safeSteps) || !safeSteps.length || safeSteps.length > 64 || !safeSteps.every(step => step && typeof step === 'object' && !Array.isArray(step) && typeof step.action === 'string' && step.action)) throw failure('INVALID_TASK', '한 개 이상의 유효한 처리 단계가 필요합니다.');
      if (typeof metadata.entity !== 'string' || !metadata.entity) throw failure('INVALID_TASK', '작업 대상 식별정보가 필요합니다.');
      const day = currentDay();
      const fingerprint = stable({entity: metadata.entity, steps: safeSteps, day});
      try {
        const stored = readTasks();
        const forEntity = stored.filter(task => task.entity === metadata.entity && task.day === day);
        const pending = forEntity.filter(task => PENDING.has(task.status));
        const lastPending = pending[pending.length - 1];
        // Only adjacent identical intents deduplicate: A → B → A must keep all three.
        const existing = lastPending && lastPending.fingerprint === fingerprint ? lastPending : null;
        if (existing) return {id: existing.id, promise: awaitTask(existing)};
        const createdAt = now();
        const random = root.crypto && typeof root.crypto.randomUUID === 'function' ? root.crypto.randomUUID() : Math.random().toString(36).slice(2) + '-' + (++sequence).toString(36);
        const task = {version: 1, id: createdAt.toString(36) + '-' + random, scope, day, label: String(metadata.label || '예약 처리'), entity: metadata.entity, effects, steps: safeSteps, fingerprint, status: 'queued', cursor: 0, results: [], createdAt, updatedAt: createdAt, ordinal: stored.reduce((max, item) => Math.max(max, ordinal(item)), 0) + 1, producer, sequence: ++producerSequence, previousEntityTaskId: forEntity.length ? forEntity[forEntity.length - 1].id : null};
        persist(task);
        const promise = awaitTask(task);
        errorState = null;
        notify();
        scheduleFlush();
        return {id: task.id, promise};
      } catch (error) { noteError(error); throw error; }
    }
    function eligible(task, tasks, day) {
      if (task.status !== 'queued' || task.day !== day) return false;
      if (typeof options.canDispatch === 'function' && options.canDispatch(clone(task)) !== true) return false;
      return !tasks.some(other => other.id !== task.id && other.day === task.day && other.entity === task.entity && ((other.status === 'uncertain' && !(typeof options.independentOfUncertain === 'function' && options.independentOfUncertain(clone(task),clone(other))===true)) || other.status === 'sending' || (other.status === 'queued' && compareTasks(other, task) < 0)));
    }
    function recoverInterrupted() {
      // Only the exclusive writer may decide a persisted `sending` record is orphaned.
      // A live sender in another tab owns this same lock until its request finishes.
      for (const task of readTasks()) {
        if (task.status !== 'sending') continue;
        task.status = 'uncertain'; task.updatedAt = now(); task.error = '앱 또는 페이지가 닫혀 전송 결과를 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.';
        persist(task);
      }
      notify();
    }
    function collapseRacedDuplicates() {
      const tasks = readTasks();
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        if (task.status !== 'queued' || task.cursor !== 0) continue;
        const races = tasks.filter(previous => previous.id !== task.id && previous.fingerprint === task.fingerprint && Object.hasOwn(previous, 'previousEntityTaskId') && Object.hasOwn(task, 'previousEntityTaskId') && previous.previousEntityTaskId === task.previousEntityTaskId);
        // A request that has already been dispatched wins even if its random ID
        // sorts after the racing record. Otherwise choose the first unsent record.
        const original = races.find(previous => ['sending', 'uncertain', 'confirmed'].includes(previous.status)) || races.find(previous => previous.status === 'queued' && compareTasks(previous, task) < 0);
        if (!original) continue;
        task.status = 'cancelled'; task.duplicateOf = original.id; task.updatedAt = now(); task.finishedAt = now();
        persist(task);
      }
    }
    async function drain() {
      if (disposed) return;
      flushing = true;
      try {
        recoverInterrupted();
        while (!disposed) {
          collapseRacedDuplicates();
          const tasks = readTasks();
          settle(tasks);
          const task = tasks.find(item => eligible(item, tasks, currentDay()));
          if (!task || !canSend()) break;
          task.status = 'sending'; task.updatedAt = now(); task.startedAt = task.startedAt || task.updatedAt;
          persist(task); // Must finish before invoking a function that can perform a write.
          notify();
          let response;
          try { response = await options.send(clone(task.steps[task.cursor]), clone(task)); }
          catch (error) {
            task.status = 'uncertain'; task.updatedAt = now(); task.error = '서버 처리 결과를 확인하지 못했습니다. 중복 처리를 막기 위해 자동으로 다시 보내지 않습니다.';
            task.errorCode = typeof error?.code === 'string' ? error.code.slice(0, 80) : 'UNCONFIRMED_RESULT';
            persist(task);
            notify();
            continue;
          }
          try { task.results.push(response === undefined ? null : clone(response)); }
          catch (_) { task.results.push(null); }
          task.cursor++;
          task.updatedAt = now();
          task.status = task.cursor === task.steps.length ? 'confirmed' : 'queued';
          if (task.status === 'confirmed') task.finishedAt = task.updatedAt;
          persist(task); // If this fails, the durable `sending` record remains ambiguous.
          notify();
        }
        errorState = null;
      } catch (error) { noteError(error); throw error; }
      finally { flushing = false; notify(); }
    }
    function exclusive(fn) {
      if (!lockSupported) return Promise.reject(failure('LOCK_UNAVAILABLE', '이 환경은 안전한 동시 실행 제어를 지원하지 않아 작업을 보관만 합니다. 최신 Chrome 또는 앱에서 열어 주세요.'));
      return Promise.resolve().then(() => locks.request(lockName, {mode: 'exclusive'}, fn));
    }
    function flush() {
      if (disposed) return Promise.resolve();
      if (!lockSupported) { notify(); return Promise.resolve(); }
      if (activeFlush) { flushAgain = true; return activeFlush; }
      activeFlush = exclusive(drain).finally(() => {
        activeFlush = null;
        if (flushAgain) { flushAgain = false; scheduleFlush(); }
      });
      return activeFlush;
    }
    async function resolve(id, status) {
      if (!['confirmed', 'cancelled'].includes(status)) throw failure('INVALID_RESOLUTION', '완료 확인 또는 취소만 가능합니다.');
      return exclusive(async () => {
        recoverInterrupted();
        const task = readTasks().find(item => item.id === id);
        if (!task) return null;
        if (task.status === status) return result(task);
        if (task.status !== 'uncertain' && !(task.status === 'queued' && status === 'cancelled')) throw failure('INVALID_RESOLUTION', '결과 확인이 필요한 작업만 완료 확인할 수 있습니다.');
        // Confirmation concerns the uncertain step, not steps that were never sent.
        // For example, a confirmed status write must still be followed by its move.
        if (status === 'confirmed') {
          task.results.push({manuallyConfirmed: true});
          task.cursor++;
          task.status = task.cursor === task.steps.length ? 'confirmed' : 'queued';
        } else task.status = 'cancelled';
        task.updatedAt = now(); task.manuallyResolved = true;
        delete task.error; delete task.errorCode;
        if (['confirmed', 'cancelled'].includes(task.status)) task.finishedAt = task.updatedAt;
        persist(task); notify(); scheduleFlush(); return result(task);
      }).catch(error => { noteError(error); throw error; });
    }
    // Verify one dispatched step from a fresh server read. A missing marker is
    // never proof that an SMS was not sent, and must never trigger a resend.
    async function verifyPending() {
      if (typeof options.verify !== 'function' || !canSend()) return [];
      return exclusive(async () => {
        recoverInterrupted();
        const verified = [];
        for (const task of readTasks()) {
          if (disposed || task.day !== currentDay() || task.status !== 'uncertain') continue;
          let evidence;
          try { evidence = await options.verify(clone(task.steps[task.cursor]), clone(task)); }
          catch (_) { continue; }
          if (evidence !== true) continue;
          task.results.push({serverVerified: true}); task.cursor++; task.updatedAt = now();
          task.status = task.cursor === task.steps.length ? 'confirmed' : 'queued';
          if (task.status === 'confirmed') task.finishedAt = task.updatedAt;
          delete task.error; delete task.errorCode;
          persist(task); verified.push(task.id);
        }
        notify(); scheduleFlush(); return verified;
      }).catch(error => { noteError(error); throw error; });
    }
    // Repair pre-3.1.2 identity grouping under the same cross-tab writer lock.
    // Preserve a separate original record before changing bookkeeping, never
    // the request payload, cursor, response or dispatch state.
    async function migrateEntities(normalize) {
      return exclusive(async () => {
        for (const task of readTasks()) {
          const entity = normalize(clone(task));
          if (typeof entity !== 'string' || !entity || entity === task.entity) continue;
          const backupKey = 'coconara:outbox-backup:3.1.2:' + encodeURIComponent(scope) + ':' + task.id;
          try { if (!storage.getItem(backupKey)) {const raw=JSON.stringify(task);storage.setItem(backupKey,raw);if(storage.getItem(backupKey)!==raw)throw new Error('backup verification failed');} }
          catch (error) { throw storageFailure(error); }
          task.entity = entity;
          task.fingerprint = stable({entity, steps: task.steps, day: task.day});
          task.identityRepaired = true;
          persist(task);
        }
        notify();
      });
    }
    async function reconcile(predicate) {
      if (typeof predicate !== 'function') throw failure('INVALID_PREDICATE', '서버 반영 확인 함수가 필요합니다.');
      return exclusive(async () => {
        const removed = [];
        for (const task of readTasks()) {
          // An absent SMS marker is not evidence of non-delivery. Uncertain tasks
          // can only be resolved by an explicit operator decision, never a retry.
          if (!['confirmed', 'cancelled'].includes(task.status) || predicate(clone(task)) !== true) continue;
          settle([task]); remove(task); removed.push(task.id);
        }
        notify(); return removed;
      }).catch(error => { noteError(error); throw error; });
    }
    function storageChanged(event) {
      if (event.storageArea && event.storageArea !== storage) return;
      if (event.key === null || (typeof event.key === 'string' && event.key.startsWith(prefix))) {
        // Another tab may reconcile/remove a confirmed record before this tab's
        // event runs. The event value still resolves its local completion promise.
        if (event.newValue) {
          try {const task = JSON.parse(event.newValue); if (task.scope === scope && event.key === prefix + task.id && Array.isArray(task.results) && TERMINAL.has(task.status)) settle([task]);} catch (_) {}
        }
        notify(); scheduleFlush();
      }
    }
    if (typeof root.addEventListener === 'function') root.addEventListener('storage', storageChanged);
    function dispose() { disposed = true; if (typeof root.removeEventListener === 'function') root.removeEventListener('storage', storageChanged); }
    scheduleFlush();
    return {enqueue, list: readTasks, flush, reconcile, resolve, verifyPending, migrateEntities, diagnostics, dispose};
  }
  return {create};
});
