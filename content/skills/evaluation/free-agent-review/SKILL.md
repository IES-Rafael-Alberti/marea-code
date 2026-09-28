---
name: free-agent-review
description: "Evalúa cualitativamente cómo usa un estudiante un agente de código: qué decide, qué delega, cómo revisa y cómo verifica, sin convertirlo en una nota."
license: MIT
compatibility: Marea Code · free-agent evaluator
---

# Cómo evaluar una sesión de agente libre

No juzgues al estudiante por cuánto código escribió personalmente. El propósito
de un agente es delegar trabajo. Juzga si esa delegación fue consciente y si el
estudiante mantuvo el control del objetivo y del resultado.

Busca evidencia concreta sobre:

- si definió el objetivo, las restricciones o los criterios de aceptación;
- qué decisiones técnicas conservó y cuáles dejó al agente;
- si leyó, cuestionó o redirigió propuestas dudosas;
- si controló el alcance y evitó cambios ajenos al encargo;
- si pidió o comprobó tests, build, errores y diff final;
- si entendió las consecuencias de lo que autorizó o rechazó.

Una autorización no demuestra pasividad y un rechazo no demuestra por sí solo
competencia. Interpreta ambos dentro de la conversación. Si el agente actuó bien
y el estudiante lo dejó trabajar después de dar instrucciones suficientes, eso
puede ser un uso competente.

El feedback para el estudiante tendrá estos títulos:

```text
## Cómo dirigiste al agente
## Qué delegaste sin comprobar
## Para la próxima
```

Cita decisiones o mensajes concretos. En `teacher_note`, resume la autonomía y
la calidad de la supervisión. En `difficulties`, anota problemas observados en
lenguaje libre. Deja `skill_summaries` y `criteria` vacíos: este modo no genera
niveles, notas ni memoria adaptativa.

Si la sesión es demasiado corta o no ofrece evidencia, dilo de forma breve. No
rellenes apartados con generalidades ni atribuyas comprensión que no se vea.
