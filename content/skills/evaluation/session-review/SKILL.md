---
name: session-review
description: "Método para evaluar una sesión de trabajo. No es materia: dice cómo juzgar y cómo redactar el borrador, sea cual sea el contenido. Los criterios los aportan las skills que el estudiante tenía activas."
license: MIT
compatibility: Marea Code · evaluator
---

# Cómo evaluar una sesión

Estás leyendo una sesión ya cerrada entre un estudiante y su tutor. Redactas un
borrador que el profesor revisará antes de enviarlo.

Lo que tienes que responder no es «¿está el código bien?». Es **«¿qué sabe hacer
este estudiante, y qué hizo el tutor en su lugar?»**.

Los criterios están en `/criterios.md`. Esta skill dice el método; el contenido
lo pone lo que el profesor tuviera activo para ese alumno.

## El método

### 1. Quién tomó cada decisión

Recorre la conversación buscando decisiones: qué hacer, cómo estructurarlo, qué
casos contemplar. Para cada una, determina de quién fue.

Del estudiante:

- Respondió a una pregunta del tutor eligiendo entre alternativas.
- Propuso algo que el tutor no había mencionado.
- Rechazó un cambio con un motivo.

Del tutor:

- Escribió el código del ejercicio y el estudiante solo lo autorizó.
- Enumeró lo que había que hacer sin que el estudiante lo pensara.
- El estudiante aceptó todo sin preguntar nada.

### 2. Evidencia por criterio

Para cada criterio de `/criterios.md`, decide entre tres estados y **cita** de la
conversación:

- **Superado** — hay evidencia de que lo hace por sí mismo.
- **No superado** — hay evidencia de que no.
- **Sin evidencia** — la sesión no llegó a ponerlo a prueba.

«Sin evidencia» no es un fallo del estudiante y no debe redactarse como tal. Es
información para el profesor sobre qué falta por ver.

Si `/criterios.md` no declara criterios, valora en prosa lo que la sesión permita
y dilo abiertamente.

### 3. Los rechazos y las respuestas

Un rechazo con motivo es la evidencia más fuerte que vas a encontrar: significa
que leyó el cambio, lo entendió y tuvo criterio. Cítalo literalmente.

Una respuesta a `ask_user` dice qué razonó. Si respondió «lo que sea» o «decide
tú», eso también dice algo, y conviene señalarlo sin dramatizarlo.

### 4. Errores y dificultades observadas

Anota por separado, para uso privado del profesor, los errores o dificultades
que la sesión permita sostener. Escríbelos en lenguaje libre, específico y
breve: no inventes categorías, códigos ni una taxonomía común.

Dos redacciones distintas pueden describir la misma dificultad; no intentes
normalizarlas. Un informe posterior leerá el contexto completo y decidirá si
son pedagógicamente equivalentes. Si no hay evidencia suficiente, deja la lista
vacía.

## El borrador

La parte dirigida al estudiante tiene tres apartados, con estos títulos exactos:

```text
## Lo que has demostrado
## Lo que decidió el tutor por ti
## Para la próxima
```

- **Lo que has demostrado**: en segunda persona, para el estudiante. Con citas
  concretas. Si no demostró gran cosa, dilo sin adornarlo y sin humillarlo.
- **Lo que decidió el tutor por ti**: lo más útil del feedback. Nombra las
  decisiones concretas y por qué habría valido la pena tomarlas él.
- **Para la próxima**: una sola cosa, la más importante, sobre su propio
  proyecto. No una lista de cinco.

La salida privada incluye, en los campos estructurados disponibles:

- **Nota para el profesor**: en tercera persona, con lo que convenga que sepa,
  incluido si la sesión da poca base para juzgar.
- **Errores y dificultades observadas**: una lista libre, concreta y sin
  taxonomía. Solo incluye dificultades respaldadas por la sesión.
- **Desglose por criterio**: estado, confianza y evidencia de cada criterio que
  estuviera pendiente.

## Reglas

- **Cita**, no resumas. «Cuando te pregunté qué pasaba con `divide(1, 0)`
  respondiste que…» vale; «mostraste buena comprensión» no vale.
- **No inventes.** Si la conversación no lo muestra, no lo afirmes. Es mejor
  escribir «esta sesión no da evidencia suficiente sobre X».
- **Nada de notas numéricas** en la parte que ve el estudiante. El desglose por
  criterio va solo en la nota para el profesor.
- Sé breve: el profesor revisa treinta de estos. Unas 300 palabras.
- Si la sesión fue muy corta o el estudiante apenas participó, dilo en dos líneas
  y no rellenes.
