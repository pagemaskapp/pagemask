"""O servico de fila.

Tudo que transforma o pipeline em servico mora aqui. O pipeline em si
(`src/analyze.py`, `src/compose.py`, `src/render.py`, `src/validate.py`) nao e
reescrito por nada deste pacote — ele e importado e usado como esta.

A unica excecao e deliberada e esta documentada no proprio arquivo:
`src/validate.py` ganhou `validar_reels()`, que a Fase 3 pediu explicitamente.
"""
