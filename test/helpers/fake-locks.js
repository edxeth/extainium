// A fake of the Web Locks API (navigator.locks) as the extension uses it:
// exclusive locks granted in request order per name, ifAvailable, query().
// One instance stands for the browser profile, shared by every context (the
// service worker and the pages). abandon(name) stands for the browser
// releasing the lock of a context that went away (a closed page): the next
// request is granted while the abandoned callback may still be pending.

export function fakeLocks() {
  const held = new Map(); // name -> token of the current holder
  const queues = new Map(); // name -> [run(lock)]
  const requests = []; // names of all requests, in order

  function grant(name, run) {
    const token = {};
    held.set(name, token);
    queueMicrotask(async () => {
      try {
        await run({ name, mode: "exclusive" });
      } finally {
        if (held.get(name) === token) release(name);
      }
    });
  }
  function release(name) {
    held.delete(name);
    const q = queues.get(name);
    if (q && q.length) grant(name, q.shift());
  }

  return {
    requests,
    request(name, options, callback) {
      if (typeof options === "function") [callback, options] = [options, {}];
      requests.push(name);
      return new Promise((resolve, reject) => {
        const run = async (lock) => {
          try {
            resolve(await callback(lock));
          } catch (e) {
            reject(e);
          }
        };
        const q = queues.get(name) || [];
        queues.set(name, q);
        if (!held.has(name) && !q.length) grant(name, run);
        else if (options.ifAvailable) queueMicrotask(() => run(null));
        else q.push(run);
      });
    },
    async query() {
      return {
        held: [...held.keys()].map((name) => ({ name, mode: "exclusive" })),
        pending: [...queues].flatMap(([name, q]) => q.map(() => ({ name, mode: "exclusive" }))),
      };
    },
    abandon(name) {
      if (!held.has(name)) throw new Error(`fake locks: abandon ${name}: not held`);
      release(name);
    },
    isHeld: (name) => held.has(name),
  };
}

// Installs a fresh fakeLocks() as navigator.locks and returns it.
export function installFakeLocks() {
  const locks = fakeLocks();
  Object.defineProperty(globalThis, "navigator", { value: { locks }, configurable: true, writable: true });
  return locks;
}
