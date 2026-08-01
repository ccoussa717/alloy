# Cache invalidation contract

`put` must invalidate the old cached value after persistence so the next read reloads it.
