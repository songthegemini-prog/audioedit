"""Writing corrections back into a document the team formatted by hand.

The thing being protected here is not the text — that part is easy — but
everything around it: the cover sheet, the superscript story markers, the tab
indents, the hand-placed double spaces. Every test below exists because that
formatting is the deliverable.
"""

from pathlib import Path

import pytest

from app.docx_update import (
    content_bounds,
    pair_up,
    plan_runs,
    set_paragraph_text,
    update_docx,
)

docx = pytest.importorskip("docx")


# --- placement rules (pure, no document needed) ---------------------------


def test_untouched_text_stays_in_the_run_it_came_from() -> None:
    # The whole reason formatting survives: a run nobody rewrites keeps its own.
    assert plan_runs(["สวัสดี", "ครับ"], "สวัสดีครับ") == [(0, "สวัสดี"), (1, "ครับ")]
    plan = plan_runs(["สวัสดี", "ครับ"], "สวัสดีค่ะ")
    assert plan[0] == (0, "สวัสดี")  # first run untouched


def test_edited_text_lands_in_the_run_it_replaces() -> None:
    plan = plan_runs(["หนึ่ง", "สอง"], "หนึ่งสาม")
    assert plan == [(0, "หนึ่ง"), (1, "สาม")]


def test_added_text_never_lands_in_a_superscript_marker() -> None:
    """The bug this caught on the team's real file.

    Their story markers sit at the END of a paragraph as often as the start,
    so words added to the end of a sentence were appended to the run before
    them — the marker — and came out raised. The marker must keep its own
    place, and the new words must get an ordinary run after it.
    """
    plan = plan_runs(["เนื้อความ", "1"], "เนื้อความ1คำที่เติม", protected=(1,))

    assert plan == [(0, "เนื้อความ"), (1, "1"), (0, "คำที่เติม")]
    #                                    ^ marker intact, in place
    #                                              ^ new run, ordinary formatting


def test_added_text_at_the_start_skips_a_leading_marker() -> None:
    # ¹[ opens a story: run 0 is the superscript, run 1 the bracket.
    plan = plan_runs(["1", "[เนื้อความ"], "1[คำนำเนื้อความ", protected=(0,))
    assert plan[0] == (0, "1")
    assert all(src != 0 for src, text in plan[1:] if text == "คำนำ")


def test_a_paragraph_of_only_markers_still_accepts_text() -> None:
    # Nothing is unprotected, so the marker takes it rather than losing it.
    assert plan_runs(["1"], "1ก", protected=(0,)) == [(0, "1ก")]


# --- pairing paragraphs with script lines ---------------------------------


def test_identical_paragraphs_pair_straight_across() -> None:
    lines = ["หนึ่ง", "สอง", "สาม"]
    assert pair_up(lines, lines) == [(0, 0), (1, 1), (2, 2)]


def test_an_edited_paragraph_still_pairs_with_its_line() -> None:
    doc = ["สวัสดีครับท่านผู้ฟังที่เคารพ", "เรื่องเริ่มมาแต่ในแคว้นกลิงคราษฎร์"]
    lines = ["สวัสดีค่ะท่านผู้ฟังที่เคารพ", "เรื่องเริ่มมาแต่ในแคว้นกลิงคราษฎร์"]
    assert pair_up(doc, lines) == [(0, 0), (1, 1)]


def test_a_removed_paragraph_pairs_with_nothing() -> None:
    doc = ["หนึ่ง", "สอง", "สาม"]
    assert pair_up(doc, ["หนึ่ง", "สาม"]) == [(0, 0), (1, None), (2, 1)]


def test_an_added_line_pairs_with_no_paragraph() -> None:
    assert pair_up(["หนึ่ง", "สาม"], ["หนึ่ง", "สอง", "สาม"]) == [(0, 0), (None, 1), (1, 1 + 1)]


def test_the_cover_sheet_falls_outside_the_content_range() -> None:
    """Why the cover sheet survives.

    It matches no script line, so it never enters the matched range, so no
    rule that operates inside that range can reach it. This is the guard
    against the one catastrophic failure: deleting the team's cover sheet
    because it "wasn't in the transcript".
    """
    doc = ["บันทึกข้อความ", "วันที่ 14", "", "เนื้อหาแรก", "เนื้อหาสอง"]
    pairs = pair_up(doc, ["เนื้อหาแรก", "เนื้อหาสอง"])
    assert content_bounds(pairs) == (3, 4)


def test_nothing_recognisable_means_no_content_range() -> None:
    # Wrong document for this audio: better to change nothing at all.
    assert content_bounds(pair_up(["ก", "ข"], [])) is None


# --- end to end, on a document with real formatting ------------------------


def _build(path: Path) -> None:
    """A miniature of the team's script: cover sheet, markers, double spaces."""
    doc = docx.Document()
    doc.add_paragraph("บันทึกข้อความ")  # cover sheet
    doc.add_paragraph("วันที่  14  สิงหาคม  2568")  # double spaces, on purpose
    doc.add_paragraph("")

    first = doc.add_paragraph()
    first.add_run("\t")
    marker = first.add_run("1")
    marker.font.superscript = True
    first.add_run("[สวัสดีครับท่านผู้ฟังที่เคารพนี่คือรายการเล่าเรื่อง")

    doc.add_paragraph("เรื่องเริ่มมาแต่ในแคว้นกลิงคราษฎร์สมัยเมื่อพระเวสสันดร")

    third = doc.add_paragraph()
    third.add_run("ถูกเนรเทศออกจากเมืองไปอยู่ป่าเขาวงกต")
    closing = third.add_run("2")
    closing.font.superscript = True

    doc.add_paragraph("ต่อมาชูชกก็ออกเดินทางไปขอสองกุมาร")
    doc.save(str(path))


def _read(path: Path):
    doc = docx.Document(str(path))
    return [p for p in doc.paragraphs]


def test_only_the_changed_paragraph_is_rewritten(tmp_path: Path) -> None:
    src, out = tmp_path / "in.docx", tmp_path / "out.docx"
    _build(src)
    lines = [p.text for p in _read(src) if p.text.strip()][2:]
    lines[1] = lines[1].replace("กลิงคราษฎร์", "กลิงคราษฎร์เก่า")

    res = update_docx(src, out, lines)

    assert (res["edited"], res["added"], res["removed"]) == (1, 0, 0)
    assert res["changes"][0]["kind"] == "แก้ไข"


def test_the_cover_sheet_and_its_double_spaces_are_untouched(tmp_path: Path) -> None:
    src, out = tmp_path / "in.docx", tmp_path / "out.docx"
    _build(src)
    lines = [p.text for p in _read(src) if p.text.strip()][2:]
    lines[0] = lines[0] + "เพิ่มคำท้ายประโยค"
    lines[-1] = "เปลี่ยนทั้งบรรทัดสุดท้าย"

    update_docx(src, out, lines)

    after = [p.text for p in _read(out)]
    assert after[0] == "บันทึกข้อความ"
    assert after[1] == "วันที่  14  สิงหาคม  2568"  # spacing exactly as typed


def test_markers_survive_an_edit_to_their_own_paragraph(tmp_path: Path) -> None:
    """Both positions: a marker opening a paragraph and one closing it."""
    src, out = tmp_path / "in.docx", tmp_path / "out.docx"
    _build(src)
    lines = [p.text for p in _read(src) if p.text.strip()][2:]
    lines[0] = lines[0] + "และคำที่เติมท้าย"  # paragraph opening with ¹[
    lines[2] = lines[2] + "และคำที่เติมท้าย"  # paragraph closing with ¹

    update_docx(src, out, lines)

    paragraphs = _read(out)
    superscripts = [r.text for p in paragraphs for r in p.runs if r.font.superscript]
    assert superscripts == ["1", "2"]  # both still there, still only the digit
    assert [p.text for p in paragraphs if p.text.strip()][2:] == lines


def test_added_and_removed_paragraphs(tmp_path: Path) -> None:
    src, out = tmp_path / "in.docx", tmp_path / "out.docx"
    _build(src)
    lines = [p.text for p in _read(src) if p.text.strip()][2:]
    dropped = lines.pop(1)
    lines.insert(2, "ย่อหน้าที่เติมเข้ามาใหม่ทั้งย่อหน้า")

    res = update_docx(src, out, lines)

    assert (res["added"], res["removed"]) == (1, 1)
    assert {c["kind"] for c in res["changes"]} == {"เพิ่มเติม", "ตัดออก"}
    after = [p.text for p in _read(out) if p.text.strip()]
    assert dropped not in after
    assert after[2:] == lines


def test_an_unrelated_document_is_left_completely_alone(tmp_path: Path) -> None:
    """The safety net. If the script does not match this document, changing
    nothing is the only honest outcome — a partial rewrite on a bad match
    would destroy work that cannot be recovered."""
    src, out = tmp_path / "in.docx", tmp_path / "out.docx"
    _build(src)
    before = [p.text for p in _read(src)]

    res = update_docx(src, out, ["ไม่เกี่ยวข้องกันเลย", "คนละเรื่องคนละไฟล์"])

    assert res["matched"] is False
    assert (res["edited"], res["added"], res["removed"]) == (0, 0, 0)
    assert [p.text for p in _read(out)] == before


def test_an_empty_script_changes_nothing(tmp_path: Path) -> None:
    src, out = tmp_path / "in.docx", tmp_path / "out.docx"
    _build(src)
    before = [p.text for p in _read(src)]

    res = update_docx(src, out, [])

    assert res["matched"] is False
    assert [p.text for p in _read(out)] == before


def test_set_paragraph_text_reports_whether_it_changed_anything(tmp_path: Path) -> None:
    src = tmp_path / "in.docx"
    _build(src)
    par = [p for p in _read(src) if p.text.strip()][3]
    assert set_paragraph_text(par, par.text) is False
    assert set_paragraph_text(par, par.text + "ต่อท้าย") is True
