"""Kleine, nachvollziehbare Korrekturen an den festgelegten Fremdprojekten."""
from pathlib import Path
import sys

root = Path(sys.argv[1])
solver = root / 'recaptcha_ia_solver/recaptcha_ia_solver/solver.py'
text = solver.read_text().replace('cells.append(arr[y1:y2, x1:x2])', 'cells.append(Image.fromarray(arr[y1:y2, x1:x2]))')
text = text.replace('image = np.asarray(Image.open("recaptcha_images/0.png").convert("RGB"))', 'image = np.asarray(Image.open("recaptcha_images/0.png").convert("RGB"))[:, :, ::-1]')
solver.write_text(text)
images = root / 'cf-solver/solvers/recaptcha/image_solve.py'
images.write_text(images.read_text().replace('rounds = max_rounds if dynamic else 2', 'rounds = max_rounds if dynamic else 1'))
