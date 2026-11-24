import numpy as np

from src.keyframes import (
    frame_key,
    grid_times,
    select_keyframes,
)


def screens(*levels_per_second):
    """One tiny grayscale frame per second, each a flat image at `level`."""
    return np.stack([np.full((36, 64), level, dtype=np.float32) for level in levels_per_second])


def times_of(selection):
    return [frame.t for frame in selection]


def test_keeps_the_first_frame_and_each_screen_change():
    frames = screens(0.1, 0.1, 0.1, 0.8, 0.8, 0.8, 0.3, 0.3)
    selection = select_keyframes(frames, max_gap=600)
    assert times_of(selection) == [0.0, 3.0, 6.0]


def test_ignores_changes_below_the_threshold():
    # A cursor blink or a webcam tile flicker: tiny mean difference.
    frames = screens(0.5, 0.505, 0.5, 0.505, 0.5)
    selection = select_keyframes(frames, threshold=0.02, max_gap=600)
    assert times_of(selection) == [0.0]


def test_waits_for_a_transition_to_settle_before_keeping_it():
    # A slide animating in over three seconds: keep the settled slide, not a
    # half-drawn frame.
    frames = screens(0.1, 0.1, 0.4, 0.6, 0.8, 0.8, 0.8)
    selection = select_keyframes(frames, max_gap=600, settle=0.01, max_settle=3)
    assert times_of(selection) == [0.0, 4.0]


def test_adds_coverage_frames_on_a_static_screen():
    frames = screens(*([0.5] * 200))
    selection = select_keyframes(frames, max_gap=60)
    assert times_of(selection) == [0.0, 60.0, 120.0, 180.0]
    assert [frame.reason for frame in selection] == ["first", "coverage", "coverage", "coverage"]


def test_respects_the_minimum_gap_between_changes():
    # Rapid flips (scrolling) must not produce a frame every second.
    frames = screens(0.1, 0.9, 0.1, 0.9, 0.1, 0.9, 0.1)
    selection = select_keyframes(frames, max_gap=600, min_gap=3, max_settle=0)
    gaps = np.diff(times_of(selection))
    assert all(gap >= 3 for gap in gaps)


def test_raises_the_threshold_until_the_cap_is_met():
    rng = np.random.default_rng(0)
    frames = screens(*rng.uniform(0, 1, size=600))
    selection = select_keyframes(frames, max_gap=10_000, min_gap=1, max_settle=0, max_keyframes=20)
    assert len(selection) <= 20
    assert selection[0].t == 0.0


def test_returns_nothing_for_an_empty_video():
    assert select_keyframes(np.zeros((0, 36, 64), dtype=np.float32)) == []


def test_grid_skips_times_that_already_have_a_keyframe():
    assert grid_times(45.0, every=10, existing=[0.0, 21.0], min_distance=2) == [10.0, 30.0, 40.0]


def test_frame_keys_sort_by_time():
    keys = [frame_key("u/v/frames/v1/", t) for t in (125.5, 3.0, 3600.25)]
    assert keys[0] == "u/v/frames/v1/000125500.jpg"
    assert sorted(keys) == [keys[1], keys[0], keys[2]]
