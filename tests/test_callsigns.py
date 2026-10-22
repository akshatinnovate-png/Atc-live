import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from callsigns import extract_callsigns, guess_speaker  # noqa: E402


def test_digit_strings():
    assert extract_callsigns("Delta 2145, runway 4 left, cleared for takeoff") == ["DAL2145"]


def test_digit_by_digit_and_niner():
    assert extract_callsigns("Speedbird one seven niner heavy, contact departure") == ["BAW179"]


def test_paired_numbers():
    assert extract_callsigns("United twenty-one forty-five, climb and maintain five thousand") == ["UAL2145"]


def test_hundred():
    assert extract_callsigns("JetBlue four hundred, taxi via alpha") == ["JBU400"]


def test_longest_telephony_wins():
    assert extract_callsigns("Air India Express 12, hold short") == ["AXB12"]


def test_multiple_and_dedup():
    text = "American 12 follow Delta 34, American 12 hold short"
    assert extract_callsigns(text) == ["AAL12", "DAL34"]


def test_no_number_no_callsign():
    assert extract_callsigns("United, say again") == []


def test_speaker_controller_leads_with_callsign():
    assert guess_speaker("Delta 2145, runway 4 left, cleared for takeoff") == "ATC"


def test_speaker_pilot_ends_with_callsign():
    assert guess_speaker("Cleared for takeoff 4 left, Delta 2145") == "PILOT"
    assert guess_speaker("Up to five thousand, Speedbird one seven niner heavy") == "PILOT"


def test_speaker_unknown():
    assert guess_speaker("Ground, good morning") is None
