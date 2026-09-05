from __future__ import annotations

from collections.abc import Sequence


class CleanupUncertaintyError(RuntimeError):
    """Carries a primary failure separately from cleanup failures."""

    def __init__(
        self,
        message: str,
        *,
        original_error: BaseException | None,
        cleanup_errors: Sequence[BaseException],
    ) -> None:
        self.original_error = original_error
        self.cleanup_errors = tuple(cleanup_errors)
        super().__init__(message)

    @property
    def cleanup_error(self) -> BaseException:
        if not self.cleanup_errors:
            raise AttributeError("cleanup uncertainty has no cleanup error")
        return self.cleanup_errors[0]


def _parts(
    error: BaseException,
) -> tuple[BaseException | None, tuple[BaseException, ...]] | None:
    if isinstance(error, CleanupUncertaintyError):
        return error.original_error, error.cleanup_errors

    missing = object()
    original = getattr(error, "original_error", missing)
    cleanup_errors = getattr(error, "cleanup_errors", missing)
    cleanup = getattr(error, "cleanup_error", missing)
    if cleanup_errors is missing and cleanup is not missing:
        cleanup_errors = (cleanup,)
    if cleanup_errors is missing:
        if "cleanup" not in type(error).__name__.lower():
            return None
        errors = getattr(error, "errors", None)
        if isinstance(errors, (tuple, list)) and errors and all(
            isinstance(item, BaseException) for item in errors
        ):
            return errors[0], tuple(errors[1:])
        return None
    if original is missing:
        original = None
    if not isinstance(cleanup_errors, (tuple, list)) or any(
        not isinstance(item, BaseException) for item in cleanup_errors
    ):
        return None
    if original is not None and not isinstance(original, BaseException):
        return None
    return original, tuple(cleanup_errors)


def classify_cleanup_uncertainty(
    error: BaseException,
) -> tuple[BaseException, tuple[BaseException, ...]] | None:
    """Return the deepest primary and every recursively nested cleanup failure."""

    def flatten_cleanup(
        current: BaseException, seen: set[int]
    ) -> list[BaseException]:
        if id(current) in seen:
            return [current]
        parts = _parts(current)
        if parts is None:
            return [current]
        seen.add(id(current))
        original, cleanup_errors = parts
        failures = [] if original is None else flatten_cleanup(original, seen)
        for cleanup in cleanup_errors:
            failures.extend(flatten_cleanup(cleanup, seen))
        return failures or [current]

    def split(
        current: BaseException, seen: set[int]
    ) -> tuple[BaseException, list[BaseException], bool]:
        if id(current) in seen:
            return current, [current], True
        parts = _parts(current)
        if parts is None:
            return current, [], False
        seen.add(id(current))
        original, cleanup_errors = parts
        if original is None:
            primary = current
            failures: list[BaseException] = []
        else:
            primary, failures, _ = split(original, seen)
        for cleanup in cleanup_errors:
            failures.extend(flatten_cleanup(cleanup, seen))
        if not failures:
            failures.append(current)
        return primary, failures, True

    primary, cleanup_errors, recognized = split(error, set())
    if not recognized:
        return None
    return primary, tuple(cleanup_errors)


def flatten_cleanup_failures(error: BaseException) -> tuple[BaseException, ...]:
    def flatten(current: BaseException, seen: set[int]) -> list[BaseException]:
        if id(current) in seen:
            return [current]
        parts = _parts(current)
        if parts is None:
            return [current]
        seen.add(id(current))
        original, cleanup_errors = parts
        failures = [] if original is None else flatten(original, seen)
        for cleanup in cleanup_errors:
            failures.extend(flatten(cleanup, seen))
        return failures or [current]

    return tuple(flatten(error, set()))
