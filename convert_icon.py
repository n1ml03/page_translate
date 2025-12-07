from PIL import Image

ico = Image.open("favicon.ico")
for size in [16, 48, 128]:
    ico.resize((size, size), Image.LANCZOS).save(f"icon{size}.png")
    print(f"Created icon{size}.png")
