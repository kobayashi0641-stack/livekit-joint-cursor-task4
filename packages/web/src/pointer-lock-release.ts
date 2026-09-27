export type PointerLockDocumentLike = {
  pointerLockElement: unknown;
  addEventListener(type: 'pointerlockchange', listener: EventListener): void;
  removeEventListener(type: 'pointerlockchange', listener: EventListener): void;
};

/**
 * Resolve from the real pointer-lock state, not from an assumed animation delay.
 * The timeout is only a safety fallback for browsers that fail to dispatch the
 * expected event; callers can still show a usable questionnaire afterwards.
 */
export function waitForPointerLockRelease(
  documentLike: PointerLockDocumentLike,
  timeoutMs = 1500,
): Promise<boolean> {
  if (documentLike.pointerLockElement === null) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (released: boolean) => {
      if (settled) return;
      settled = true;
      documentLike.removeEventListener('pointerlockchange', handleChange);
      clearTimeout(timeout);
      resolve(released);
    };
    const handleChange: EventListener = () => {
      if (documentLike.pointerLockElement === null) finish(true);
    };
    const timeout = setTimeout(() => finish(documentLike.pointerLockElement === null), timeoutMs);
    documentLike.addEventListener('pointerlockchange', handleChange);
    handleChange(new Event('pointerlockchange'));
  });
}
