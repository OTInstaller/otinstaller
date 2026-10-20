from datetime import date

from otinstaller import deprecation


def test_notice_before_end_of_life():
    text = deprecation.notice(date(2026, 10, 20))
    assert "security fixes only until 2027-06-30" in text
    assert "ot command" in text
    assert deprecation.GUIDE in text
    assert "OTINSTALLER_NO_DEPRECATION_WARNING=1" in text


def test_notice_on_the_last_day_is_still_maintenance():
    assert "security fixes only" in deprecation.notice(deprecation.END_OF_LIFE)


def test_notice_after_end_of_life():
    text = deprecation.notice(date(2027, 7, 1))
    assert "reached end of life on 2027-06-30" in text
    assert "no more fixes" in text


def test_notice_is_neutral():
    for day in (date(2026, 10, 20), date(2027, 7, 1)):
        assert "OSINT" not in deprecation.notice(day).upper()


def test_should_show():
    assert deprecation.should_show({})
    assert not deprecation.should_show({"OTINSTALLER_NO_DEPRECATION_WARNING": "1"})


def test_entry_point_prints_notice_on_stderr(monkeypatch, capsys):
    from otinstaller import cli

    monkeypatch.delenv("OTINSTALLER_NO_DEPRECATION_WARNING", raising=False)
    monkeypatch.setattr(cli, "app", lambda: None)
    cli.run_cli()
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "otinstaller is in maintenance" in captured.err or "end of life" in captured.err


def test_entry_point_hides_notice(monkeypatch, capsys):
    from otinstaller import cli

    monkeypatch.setenv("OTINSTALLER_NO_DEPRECATION_WARNING", "1")
    monkeypatch.setattr(cli, "app", lambda: None)
    cli.run_cli()
    assert capsys.readouterr().err == ""
