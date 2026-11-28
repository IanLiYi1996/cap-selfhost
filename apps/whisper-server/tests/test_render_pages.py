import pymupdf

from src.render_pages import OUTPUT_WIDTH, page_key, render, zoom_for


def test_page_keys_sort_in_page_order():
    assert page_key("u/v/materials/m/pages/", 7) == "u/v/materials/m/pages/0007.jpg"
    assert page_key("p", 12) > page_key("p", 9)


def test_zoom_renders_pages_about_output_width():
    assert zoom_for(612) * 612 == OUTPUT_WIDTH
    assert zoom_for(10) == 4.0
    assert zoom_for(0) == 1.0


def test_renders_each_page_with_its_text(tmp_path):
    path = tmp_path / "doc.pdf"
    with pymupdf.open() as document:
        for text in ("Dispatch rules", "Second page"):
            page = document.new_page()
            page.insert_text((72, 72), text)
        blank = document.new_page()
        blank.draw_rect(pymupdf.Rect(50, 50, 200, 200), color=(1, 0, 0), fill=(1, 0, 0))
        document.save(path)

    pages = list(render(str(path)))
    assert [page[0] for page in pages] == [1, 2, 3]
    assert pages[0][4] == "Dispatch rules"
    assert pages[2][4] == ""
    number, jpeg, width, height, _ = pages[1]
    assert jpeg[:2] == b"\xff\xd8"
    assert width == OUTPUT_WIDTH
    assert height > width


def test_stops_at_the_page_limit(tmp_path):
    path = tmp_path / "long.pdf"
    with pymupdf.open() as document:
        for _ in range(5):
            document.new_page()
        document.save(path)
    assert len(list(render(str(path), max_pages=3))) == 3
