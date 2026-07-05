# Markov-SIL — projetista de SIF (PFD / SIL)

Produto web para **desenhar a cadeia de Markov de uma SIF** e obter, do próprio
diagrama, a **matriz geradora Λ**, a **curva PFD(t)**, a **PFDavg** e o
**intervalo de teste máximo T_I** que mantém o SIL requerido (norma N-2595 rev E).

O núcleo numérico é o algoritmo de dois passos da disciplina — **Laplace +
inversão por quadratura de Gauss-Legendre** (método de Oliveira et al.) — extraído
do `backend.py`, mantido em `mpmath` com 50 dígitos porque a matriz de inversão *A*
é mal-condicionada.

```
markov-sil/
├── backend/
│   ├── core.py          # solver: gauss_legendre, solve_markov, pfd_t, pfd_avg, ti_maximo, validar, build_lambda
│   ├── app.py           # API FastAPI + serve o frontend
│   └── requirements.txt
├── frontend/
│   ├── index.html       # editor visual da cadeia de Markov
│   ├── style.css
│   └── app.js           # engine do grafo (estados, transições) + gráficos
├── Dockerfile
├── render.yaml          # deploy 1-clique no Render
└── README.md
```


## Como usar

1. Clique **Exemplo A** para carregar o problema Fire & Gas já pronto (bate com o
   `backend.py`: PFDavg ≈ 1,12×10⁻² em 8760 h, T_I,máx ≈ 7802 h).
2. Ou monte do zero: ferramenta **Estado** e clique no fundo para criar círculos;
   **Transição**, clique na origem e depois no destino, informe a taxa (ex.: `3*lD`,
   `lP+lS`, ou um número `2.5e-6`).
3. No **Inspetor**, marque os estados de falha como *indisponível* e ajuste P(0).
4. Escolha o **SIL requerido** e o **tempo de missão**, clique **Analisar**.

As taxas aceitam expressões com os parâmetros e `+ - * / ** ( )`.

---

## Rodar localmente

```bash
cd backend
pip install -r requirements.txt
uvicorn app:app --reload --port 8000
```

Abra <http://localhost:8000>. A mesma aplicação serve a API (`/api/analyze`) e a
interface.

---

## Deploy web

A aplicação é **um único serviço** (FastAPI serve API + frontend), então o deploy
é direto. Três caminhos, do mais simples ao mais portátil.

### Opção 1 — Render (grátis, recomendado)

1. Suba a pasta `markov-sil/` para um repositório no GitHub.
2. Em <https://render.com> → **New → Blueprint**, aponte para o repositório.
   O `render.yaml` já define tudo (build, start command, porta via `$PORT`).
3. Confirme. Em ~2 min a URL pública fica disponível (ex.:
   `https://markov-sil.onrender.com`).

Sem blueprint, dá para criar **New → Web Service** manualmente:
- *Root directory:* `backend`
- *Build:* `pip install -r requirements.txt`
- *Start:* `uvicorn app:app --host 0.0.0.0 --port $PORT`

> No plano grátis o serviço "dorme" após inatividade; a primeira requisição
> demora alguns segundos para acordar. Suficiente para demonstração/entrega.

### Opção 2 — Docker (qualquer host: Railway, Fly.io, VPS, etc.)

```bash
docker build -t markov-sil .
docker run -p 8000:8000 markov-sil
```

- **Railway:** *New Project → Deploy from repo*; ele detecta o `Dockerfile` e
  injeta `$PORT` automaticamente.
- **Fly.io:** `fly launch` (usa o `Dockerfile`) e depois `fly deploy`.

### Opção 3 — qualquer PaaS Python

Basta o comando de start `uvicorn app:app --host 0.0.0.0 --port $PORT` a partir de
`backend/`, com `requirements.txt` instalado.

---

## Por que o cálculo fica no servidor (e não no navegador)

O enunciado alerta que a matriz *A* da inversão é mal-condicionada e pode exigir
alta precisão. O `mpmath` roda com 50 dígitos decimais no backend — precisão que o
`Number` de 64 bits do JavaScript não alcança. Por isso a interface só **desenha**
o grafo e **plota**; a matemática pesada é resolvida em Python. A validação contra
`exp(Λt)·P(0)` acompanha cada análise para você reportar o erro no relatório.

> A GUI é a única etapa que a norma do trabalho permite fazer via IA; o backend
> (`core.py`) é o seu algoritmo de dois passos, apenas reorganizado e com cache
> para responder rápido na web.
