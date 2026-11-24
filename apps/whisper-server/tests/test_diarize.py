from src.diarize import (
    SpeakerSegment,
    assign_speakers,
    is_believable,
    normalise_speakers,
)


def w(text, start, end):
    return {"text": text, "start": start, "end": end, "confidence": 0.9}


class TestNormaliseSpeakers:
    def test_relabels_sparse_cluster_ids_in_order_of_appearance(self):
        # 实测:四个说话人的 cluster id 是 0,1,2,4 —— 稀疏且任意。
        # 直接用会在三人会议里显示 "speaker 4"。
        raw = [(0.0, 6.9, 0), (7.0, 10.8, 1), (13.8, 17.0, 2), (27.6, 29.5, 4)]

        assert [s.speaker for s in normalise_speakers(raw)] == ["A", "B", "C", "D"]

    def test_keeps_one_label_per_cluster_across_reappearances(self):
        raw = [(0.0, 2.0, 3), (2.0, 4.0, 7), (4.0, 6.0, 3)]

        assert [s.speaker for s in normalise_speakers(raw)] == ["A", "B", "A"]

    def test_orders_by_start_time_before_labelling(self):
        # 上游按时间排过序，但标签必须由"首次出现"决定，不能依赖输入顺序
        raw = [(5.0, 6.0, 9), (1.0, 2.0, 4)]

        result = normalise_speakers(raw)

        assert [(s.start, s.speaker) for s in result] == [(1.0, "A"), (5.0, "B")]

    def test_survives_more_speakers_than_letters(self):
        raw = [(float(i), float(i) + 0.5, i) for i in range(28)]

        labels = [s.speaker for s in normalise_speakers(raw)]

        assert labels[0] == "A"
        assert labels[25] == "Z"
        assert labels[26] == "S27"

    def test_handles_no_segments(self):
        assert normalise_speakers([]) == []


class TestAssignSpeakers:
    segments = [
        SpeakerSegment(0.0, 5.0, "A"),
        SpeakerSegment(5.2, 9.0, "B"),
    ]

    def test_labels_words_inside_a_segment(self):
        words = [w("你好", 1.0, 1.4), w("世界", 6.0, 6.5)]

        result = assign_speakers(words, self.segments)

        assert [x["speaker"] for x in result] == ["A", "B"]

    def test_picks_the_segment_with_the_most_overlap_at_a_boundary(self):
        # 中文常常一个字一个词，只有 ~100ms，正好压在说话人边界上。
        # 取中点会不稳定，所以按重叠时长最大来判。
        mostly_a = w("啊", 4.7, 5.3)  # 0.3s in A, 0.1s in B
        mostly_b = w("嗯", 4.95, 5.6)  # 0.05s in A, 0.4s in B

        result = assign_speakers([mostly_a, mostly_b], self.segments)

        assert [x["speaker"] for x in result] == ["A", "B"]

    def test_attributes_a_word_that_falls_in_the_gap_to_the_nearest_segment(self):
        # 分段边界和词边界是独立算出来的，差几十毫秒是常态
        result = assign_speakers([w("呃", 5.05, 5.15)], self.segments)

        assert result[0]["speaker"] in ("A", "B")

    def test_leaves_a_word_unlabelled_when_nothing_is_close(self):
        result = assign_speakers([w("远", 50.0, 50.5)], self.segments)

        assert result[0]["speaker"] is None

    # Diarization must never be able to cost us the transcript.
    def test_is_a_no_op_without_segments(self):
        words = [w("你好", 1.0, 1.4)]

        assert assign_speakers(words, []) == words

    def test_does_not_mutate_the_input_words(self):
        words = [w("你好", 1.0, 1.4)]

        assign_speakers(words, self.segments)

        assert "speaker" not in words[0]

    def test_preserves_text_and_timings(self):
        words = [w("你好", 1.0, 1.4)]

        result = assign_speakers(words, self.segments)

        assert result[0]["text"] == "你好"
        assert result[0]["start"] == 1.0
        assert result[0]["end"] == 1.4
        assert result[0]["confidence"] == 0.9


class TestIsBelievable:
    def seg(self, n):
        # n 个说话人，每人一段
        return normalise_speakers([(float(i), float(i) + 1.0, i) for i in range(n)])

    def test_accepts_a_plausible_meeting(self):
        for n in [1, 2, 4, 10]:
            assert is_believable(self.seg(n)), n

    # 实测：31 分钟会议出 24 类，50 分钟出 62-80 类，而真实人数是 4。
    # 固定阈值聚类不是"失败"，是"凭空造出说话人"。
    def test_rejects_a_count_that_cannot_be_real(self):
        for n in [11, 24, 62, 80]:
            assert not is_believable(self.seg(n)), n

    def test_accepts_no_segments(self):
        # 没有分离结果本身就是合法的降级状态
        assert is_believable([])
