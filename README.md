# Repaso para el parcial

Chatbot de práctica con Gemini: secciones de 10 preguntas (opción múltiple, abiertas o mixtas) sobre el material de `material/`, con retroalimentación en cada una y una nota final de 0 a 5 (aprueba con 3.0).

Las abiertas se evalúan como Incorrecta (0), Superficial (0,3), Parcial (0,6) o Sólida (1 punto). Entre consultas hay una espera automática calculada según el tamaño del material, para no pasar los límites por minuto del plan gratuito.

## Correr en local

Requiere Node 22. En PowerShell, desde esta carpeta:

```powershell
$env:GEMINI_API_KEY='tu-api-key'
node dev-server.mjs
```

Abre http://localhost:3000.

## Cambiar de materia

Cada `.md` de `material/` es un tema que la estudiante puede elegir; el título que aparece en la página es su primera línea `# ...`. Reemplaza o agrega archivos y la lista de temas se actualiza sola; "Repaso general" usa todos juntos.
En local no hace falta reiniciar; en Netlify basta con hacer push.

Cada pregunta trae una cita del material y el servidor comprueba que exista textualmente; si no, la descarta y genera otra. Así se evitan preguntas inventadas.

## Publicar en Netlify

1. Sube la carpeta a un repositorio **privado** de GitHub (así el material no queda público).
2. En Netlify: **Add new project → Import an existing project** y elige el repositorio. No hace falta configurar build: lo toma de `netlify.toml`.
3. En **Project configuration → Environment variables**, agrega `GEMINI_API_KEY` con tu key.
4. Despliega. Cada push a GitHub vuelve a publicar solo.

## Estructura

- `public/index.html`: la interfaz.
- `netlify/functions/quiz.mjs`: llama a Gemini; el modelo se cambia en la constante `model`.
- `material/`: el contenido de la materia, un archivo por tema.
- `revision-material.md`: qué fuente cubre cada tema y qué se corrigió (no lo usa la app).
- `datos parcial/`: material original; no se sube a GitHub (`.gitignore`).
- `dev-server.mjs`: solo para local; ejecuta la misma función que usa Netlify.
