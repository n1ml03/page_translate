"""
Quick test script for Gemini API.
Run directly to test your API key and basic functionality.
"""

import os

from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()


def test_basic_chat():
    """Test basic chat functionality."""
    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

    response = client.models.generate_content(
        model="gemini-2.0-flash",
        contents="Say hello in Japanese, Korean, and Chinese.",
    )

    print("Basic Chat Test:")
    print("-" * 40)
    print(response.text)
    print()


def test_with_system_instruction():
    """Test with system instruction."""
    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

    config = types.GenerateContentConfig(
        temperature=0.3,
        system_instruction="You are a translator. Translate the user's text to Japanese. Only output the translation, nothing else.",
    )

    response = client.models.generate_content(
        model="gemini-2.0-flash",
        contents="Hello, how are you today?",
        config=config,
    )

    print("System Instruction Test:")
    print("-" * 40)
    print(response.text)
    print()


def test_multi_turn():
    """Test multi-turn conversation."""
    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

    contents = [
        types.Content(role="user", parts=[types.Part(text="My name is Alice.")]),
        types.Content(
            role="model", parts=[types.Part(text="Nice to meet you, Alice!")]
        ),
        types.Content(role="user", parts=[types.Part(text="What's my name?")]),
    ]

    response = client.models.generate_content(
        model="gemini-2.0-flash",
        contents=contents,
    )

    print("Multi-turn Test:")
    print("-" * 40)
    print(response.text)
    print()


def list_models():
    """List available models."""
    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

    print("Available Models:")
    print("-" * 40)
    for model in client.models.list():
        print(f"  {model.name}")
    print()


if __name__ == "__main__":
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key or api_key == "your_api_key_here":
        print("Error: Set GEMINI_API_KEY in .env file")
        print("Get your key at: https://aistudio.google.com/apikey")
        exit(1)

    print("=" * 50)
    print("Gemini API Test")
    print("=" * 50)
    print()

    list_models()
    test_basic_chat()
    test_with_system_instruction()
    test_multi_turn()
