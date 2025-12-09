"""
Unit tests for StreamingJSONArrayParser with placeholder handling.
Tests the enhanced parser's ability to handle split placeholders across chunks.

Requirements: 5.1, 5.2, 5.3
"""

import sys
import os

# Add the server directory to the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from server import StreamingJSONArrayParser


def test_basic_parsing():
    """Test basic JSON array parsing without placeholders."""
    parser = StreamingJSONArrayParser()
    
    # Feed complete JSON array
    items = parser.feed('["hello", "world"]')
    assert items == ["hello", "world"], f"Expected ['hello', 'world'], got {items}"
    print("✓ Basic parsing works")


def test_chunked_parsing():
    """Test parsing JSON array split across chunks."""
    parser = StreamingJSONArrayParser()
    
    # Feed in chunks
    items1 = parser.feed('["hel')
    assert items1 == [], f"Expected [], got {items1}"
    
    items2 = parser.feed('lo", "wor')
    assert items2 == ["hello"], f"Expected ['hello'], got {items2}"
    
    items3 = parser.feed('ld"]')
    assert items3 == ["world"], f"Expected ['world'], got {items3}"
    print("✓ Chunked parsing works")


def test_placeholder_complete():
    """Test parsing with complete placeholders."""
    parser = StreamingJSONArrayParser()
    
    items = parser.feed('["<x0>Hello</x0>", "<x1/>"]')
    assert items == ["<x0>Hello</x0>", "<x1/>"], f"Expected complete placeholders, got {items}"
    print("✓ Complete placeholder parsing works")


def test_split_placeholder_opening():
    """Test handling of split opening placeholder: <x split from 0>"""
    parser = StreamingJSONArrayParser()
    
    # First chunk ends with incomplete placeholder "<x"
    items1 = parser.feed('["<x')
    assert items1 == [], f"Expected [], got {items1}"
    
    # Complete the placeholder
    items2 = parser.feed('0>Hello</x0>"]')
    assert items2 == ["<x0>Hello</x0>"], f"Expected ['<x0>Hello</x0>'], got {items2}"
    print("✓ Split opening placeholder (<x | 0>) works")


def test_split_placeholder_closing():
    """Test handling of split closing placeholder: </x split from 0>"""
    parser = StreamingJSONArrayParser()
    
    # First chunk ends with incomplete closing placeholder "</x"
    items1 = parser.feed('["<x0>Hello</x')
    assert items1 == [], f"Expected [], got {items1}"
    
    # Complete the placeholder
    items2 = parser.feed('0>"]')
    assert items2 == ["<x0>Hello</x0>"], f"Expected ['<x0>Hello</x0>'], got {items2}"
    print("✓ Split closing placeholder (</x | 0>) works")


def test_split_placeholder_self_closing():
    """Test handling of split self-closing placeholder: <x0 split from />"""
    parser = StreamingJSONArrayParser()
    
    # First chunk ends with incomplete self-closing placeholder "<x0/"
    items1 = parser.feed('["Text <x0/')
    assert items1 == [], f"Expected [], got {items1}"
    
    # Complete the placeholder
    items2 = parser.feed('> more"]')
    assert items2 == ["Text <x0/> more"], f"Expected ['Text <x0/> more'], got {items2}"
    print("✓ Split self-closing placeholder (<x0/ | >) works")


def test_split_at_angle_bracket():
    """Test handling when split occurs at < character."""
    parser = StreamingJSONArrayParser()
    
    # First chunk ends with just "<"
    items1 = parser.feed('["Hello <')
    assert items1 == [], f"Expected [], got {items1}"
    
    # Complete the placeholder
    items2 = parser.feed('x0>World</x0>"]')
    assert items2 == ["Hello <x0>World</x0>"], f"Expected ['Hello <x0>World</x0>'], got {items2}"
    print("✓ Split at angle bracket (<) works")


def test_multiple_items_with_placeholders():
    """Test parsing multiple items with placeholders."""
    parser = StreamingJSONArrayParser()
    
    items = parser.feed('["<x0>First</x0>", "<x1>Second</x1>", "<x2/>"]')
    expected = ["<x0>First</x0>", "<x1>Second</x1>", "<x2/>"]
    assert items == expected, f"Expected {expected}, got {items}"
    print("✓ Multiple items with placeholders works")


def test_nested_placeholders():
    """Test parsing with nested placeholders."""
    parser = StreamingJSONArrayParser()
    
    items = parser.feed('["<x0><x1>Nested</x1></x0>"]')
    assert items == ["<x0><x1>Nested</x1></x0>"], f"Expected nested placeholders, got {items}"
    print("✓ Nested placeholders work")


def test_no_false_positive_on_regular_text():
    """Test that regular text ending with < is handled correctly."""
    parser = StreamingJSONArrayParser()
    
    # Text with < that's not a placeholder should still wait
    # because it could be the start of a placeholder
    items1 = parser.feed('["5 <')
    assert items1 == [], f"Expected [], got {items1}"
    
    # Complete with non-placeholder content
    items2 = parser.feed(' 10"]')
    assert items2 == ["5 < 10"], f"Expected ['5 < 10'], got {items2}"
    print("✓ Regular text with < handled correctly")


def test_empty_string():
    """Test parsing empty strings in array."""
    parser = StreamingJSONArrayParser()
    
    items = parser.feed('["", "text", ""]')
    assert items == ["", "text", ""], f"Expected ['', 'text', ''], got {items}"
    print("✓ Empty strings work")


def test_escaped_quotes():
    """Test parsing strings with escaped quotes."""
    parser = StreamingJSONArrayParser()
    
    items = parser.feed('["He said \\"hello\\"", "<x0>Test</x0>"]')
    expected = ['He said "hello"', "<x0>Test</x0>"]
    assert items == expected, f"Expected {expected}, got {items}"
    print("✓ Escaped quotes work")


def test_placeholder_validation_complete():
    """Test that feed() validates placeholders are complete before yielding (Requirement 5.3)."""
    parser = StreamingJSONArrayParser()
    
    # Complete placeholders should be yielded
    items = parser.feed('["<x0>Text</x0>"]')
    assert items == ["<x0>Text</x0>"], f"Expected complete item, got {items}"
    print("✓ Placeholder validation allows complete placeholders")


def test_placeholder_validation_incomplete():
    """Test that feed() holds incomplete placeholders (Requirement 5.3)."""
    parser = StreamingJSONArrayParser()
    
    # Incomplete placeholder at end should not be yielded
    items1 = parser.feed('["<x0>Text</x')
    assert items1 == [], f"Expected [], got {items1}"
    
    # After completing, should yield
    items2 = parser.feed('0>"]')
    assert items2 == ["<x0>Text</x0>"], f"Expected complete item, got {items2}"
    print("✓ Placeholder validation holds incomplete placeholders")


def test_placeholder_validation_multi_digit():
    """Test placeholder validation with multi-digit indices."""
    parser = StreamingJSONArrayParser()
    
    # Test with double-digit placeholder
    items1 = parser.feed('["<x10>Text</x1')
    assert items1 == [], f"Expected [], got {items1}"
    
    items2 = parser.feed('0>"]')
    assert items2 == ["<x10>Text</x10>"], f"Expected ['<x10>Text</x10>'], got {items2}"
    print("✓ Multi-digit placeholder validation works")


def test_yields_complete_strings_with_intact_placeholders():
    """Test that yielded items have all placeholders intact (Requirement 5.3)."""
    parser = StreamingJSONArrayParser()
    
    # Feed a complete JSON array with multiple placeholders
    json_input = '["<x0>Hello</x0> <x1>World</x1>", "<x2/>", "No placeholders"]'
    items = parser.feed(json_input)
    
    expected = ["<x0>Hello</x0> <x1>World</x1>", "<x2/>", "No placeholders"]
    assert items == expected, f"Expected {expected}, got {items}"
    
    # Verify each item has intact placeholders
    assert "<x0>" in items[0] and "</x0>" in items[0], "First item missing x0 placeholders"
    assert "<x1>" in items[0] and "</x1>" in items[0], "First item missing x1 placeholders"
    assert "<x2/>" in items[1], "Second item missing self-closing placeholder"
    print("✓ Yielded items have intact placeholders")


def run_all_tests():
    """Run all tests."""
    print("=" * 50)
    print("StreamingJSONArrayParser Tests")
    print("=" * 50)
    print()
    
    tests = [
        test_basic_parsing,
        test_chunked_parsing,
        test_placeholder_complete,
        test_split_placeholder_opening,
        test_split_placeholder_closing,
        test_split_placeholder_self_closing,
        test_split_at_angle_bracket,
        test_multiple_items_with_placeholders,
        test_nested_placeholders,
        test_no_false_positive_on_regular_text,
        test_empty_string,
        test_escaped_quotes,
        test_placeholder_validation_complete,
        test_placeholder_validation_incomplete,
        test_placeholder_validation_multi_digit,
        test_yields_complete_strings_with_intact_placeholders,
    ]
    
    passed = 0
    failed = 0
    
    for test in tests:
        try:
            test()
            passed += 1
        except AssertionError as e:
            print(f"✗ {test.__name__}: {e}")
            failed += 1
        except Exception as e:
            print(f"✗ {test.__name__}: Unexpected error: {e}")
            failed += 1
    
    print()
    print("=" * 50)
    print(f"Results: {passed} passed, {failed} failed")
    print("=" * 50)
    
    return failed == 0


if __name__ == "__main__":
    success = run_all_tests()
    sys.exit(0 if success else 1)
