---
name: testing
description: Diseñar y escribir pruebas automáticas. Úsala cuando el estudiante tenga que decidir qué probar, cómo aislar el código bajo prueba, o qué hacer con los casos límite. También cuando haya que interpretar un test que falla.
license: MIT
compatibility: Marea Code
curriculo:
  modulos:
    - codigo: "0485"
      nombre: Programación
  fuente: "Real Decreto 405/2023, anexo I, módulo 0485, RA3.f: https://www.boe.es/buscar/doc.php?id=BOE-A-2023-13221"
criterios:
  - codigo: testing-casos
    enunciado: Se han definido casos de prueba pertinentes para el código propio
    referencias:
      - modulo:
          codigo: "0485"
          nombre: Programación
        ra: 3
        criterio: f
    niveles:
      - Reconoce con preguntas qué comportamiento normal conviene comprobar y plantea un caso guiado
      - Elige casos normales y casos límite para una función familiar con ayuda puntual
      - Selecciona y justifica autónomamente casos no redundantes para una situación no trivial
      - Diseña una estrategia de pruebas basada en riesgos para código nuevo o complejo y argumenta qué deja fuera
  - codigo: testing-unitarias
    enunciado: Se han realizado pruebas unitarias y se ha interpretado su resultado
    referencias:
      - modulo:
          codigo: "0485"
          nombre: Programación
        ra: 3
        criterio: f
    niveles:
      - Ejecuta una prueba con guía y localiza el valor esperado, el obtenido y la línea del fallo
      - Escribe e interpreta una prueba unitaria sencilla en código familiar con ayuda puntual
      - Distingue autónomamente si un fallo está en el código, en el test o en su preparación
      - Diseña y depura una suite no trivial, aislando dependencias y justificando sus decisiones
  - codigo: testing-limites
    enunciado: Se han contemplado los casos límite y las condiciones de error
    referencias:
      - modulo:
          codigo: "0485"
          nombre: Programación
        ra: 3
        criterio: f
    niveles:
      - Reconoce con preguntas un caso situado en la frontera de una entrada válida
      - Prueba entradas inválidas y errores previsibles en una función familiar con ayuda puntual
      - Deriva autónomamente casos límite y condiciones de error desde el contrato y el flujo del código
      - Prioriza combinaciones de fallo nuevas o complejas sin duplicar pruebas y explica los riesgos cubiertos
---

<!-- `criterios` is optional. When present, Marea lists each criterion for the
     teacher and asks the evaluator to assess it. Each criterion may define
     exactly four levels; otherwise Marea uses its standard progression levels.
     DeepAgents ignores this additional frontmatter field. -->

# Testing

Esta skill define qué tiene que llegar a saber hacer el estudiante y cómo
comprobarlo. El objetivo no es que su proyecto acabe con tests: es que sepa
decidir cuáles escribir.

## Relación curricular

Los tres criterios propios de esta skill concretan aspectos de **Programación
(0485), RA3, criterio f**, relativo a la prueba y depuración de programas.
La numeración está recogida en el [Real Decreto 405/2023, anexo I](https://www.boe.es/buscar/doc.php?id=BOE-A-2023-13221)
y coincide con el currículo andaluz de DAW de la [Orden de 16 de junio de 2011](https://www.juntadeandalucia.es/boja/2011/149/23).

Los enunciados y los cuatro niveles de esta skill son indicadores didácticos
propios. Aportan evidencias parciales sobre ese criterio; no equivalen a superar
por completo el resultado de aprendizaje. Conserva esta distinción al evaluar.
Los antiguos identificadores RA5.c, RA5.d y RA5.e de este ejemplo no eran
referencias correctas a Programación; las sesiones anteriores conservan su
versión original y no deben reinterpretarse con esta correspondencia.

## Lo que tiene que dominar

En orden de dificultad. No pases al siguiente hasta que el anterior lo haga sin
ayuda:

1. **Ejecutar los tests y leer el fallo.** Distinguir qué falló, en qué línea, y
   qué valor esperaba frente a qué recibió.
2. **Un test para un caso normal.** Preparar la entrada, llamar, comprobar el
   resultado con un `assert`.
3. **Elegir qué casos probar.** El caso normal, los bordes, y lo que debe fallar.
   Aquí es donde está el aprendizaje de verdad.
4. **Probar los errores.** Que una función lance lo que debe cuando la entrada es
   inválida.
5. **Aislar.** Cuando el código depende del reloj, de la red o de un fichero,
   entender por qué eso hace el test frágil y qué se puede hacer.

## Cómo plantear el ejercicio

Busca en su código una función que **no tenga tests y pueda romperse**. Las
mejores candidatas: aritmética con casos límite, parseo de texto, validaciones,
cualquier cosa con un `if` que trate un caso especial.

Enséñale la función y pregúntale, con `ask_user`:

- ¿Qué tendría que pasar si la llamas con una entrada normal?
- ¿Qué entradas crees que la romperían?
- De esas, ¿cuáles merece la pena probar y cuáles no?

La tercera pregunta es la importante. Un estudiante que empieza quiere probar
todo o no probar nada; aprender a testear es aprender a elegir.

## Qué no hacer

- **No le escribas los tests.** Puedes preparar el fichero de configuración de
  pytest, instalar la dependencia y enseñarle un ejemplo de una función que *no*
  sea la suya. Los tests de su código los escribe él.
- No le des la lista de casos a probar. Que la saque él respondiendo a tus
  preguntas; si se deja uno importante, pregúntale por esa entrada concreta en
  vez de decirle que le falta.
- No corrijas su `assert` directamente. Ejecuta el test, muéstrale el fallo y
  deja que lo interprete.

## Cómo saber si lo ha entendido

Buenas señales:

- Prueba un caso que no le habías mencionado.
- Distingue entre «el test falla» y «el código está mal»: a veces el test está
  mal escrito, y darse cuenta de eso es señal de que entiende qué está haciendo.
- Sabe decir por qué **no** prueba algo.

Malas señales, y cómo reaccionar:

- Copia el mismo test cambiando números. Pregúntale qué caso nuevo cubre eso.
- Escribe `assert resultado` sin comparar con nada. Pregúntale qué valor espera
  exactamente.
- Ajusta el valor esperado hasta que el test pase. Aquí hay que parar y preguntar
  qué debería devolver la función según él, antes de mirar qué devuelve.

## Vocabulario, si pregunta

Explícalo cuando lo pregunte, con un ejemplo que no sea su ejercicio:

- **Caso límite**: la entrada en la frontera de lo válido. El cero, la lista
  vacía, el último elemento.
- **Fixture**: código que prepara lo que el test necesita, para no repetirlo.
- **Mock**: un sustituto de algo real (la red, el reloj) para que el test no
  dependa de ello.
- **Cobertura**: qué porcentaje del código ejecutan los tests. Útil para
  encontrar huecos, mala como objetivo en sí.
