# Using Marea as a student

This guide covers what to do in a few situations you may meet while working with Marea.
Marea speaks your interface language. Spanish is the default, and the messages below are
quoted as Marea shows them in Spanish. Run `marea` from your project folder, as your teacher
explained.

## Change how you sign in

Marea remembers your sign-in for each server and project folder. To choose a different method
next time, for example Google instead of a password, run this from the project folder:

```sh
marea logout
```

Marea answers «Sesión cerrada. La próxima vez que ejecutes marea podrás elegir cómo iniciar
sesión.» and does nothing else:

- It does not open the conversation.
- It does not contact the teacher's server.
- It keeps your session, so your work and history stay as they were.

Running it again when you are already signed out is harmless. The next time you run `marea`,
it asks how you want to sign in.

## Marea says you are not in the project's root folder

Marea records the changes of one project. Your project's root is the folder where its Git
repository starts. If you run Marea from a folder inside that project, Marea shows both
folders:

> Marea debe ejecutarse desde la carpeta raíz de tu proyecto. Estás en `X`, pero el
> repositorio Git empieza en `Y`.

Choose one of the two options:

- **Salir** is the default and usually the right choice. Run the `cd` command that Marea
  shows, which takes you to the root folder, and start `marea` again.
- **Crear un repositorio nuevo en `X`** makes the current folder a separate project. Choose
  it only when this folder really is a different project from the one around it.

If Marea adds that the repository covers your home folder, that repository was probably
created by mistake. Ask your teacher before you delete anything.

## Approve several actions in one turn

Sometimes the tutor asks to do several things at once, for example to run two commands.
Marea then asks about each action in order:

- The title shows where you are, for example «Acción 1 de 3».
- Under **Después:** Marea lists the actions that follow.

For each action you can:

- **Autorizar** (key `Y`) to approve this action only.
- **Rechazar** (key `N`) to reject this action and, if you want, say why. Rejecting one action
  does not cancel the others; Marea still asks about the rest.
- **Autorizar todas** (key `A`) to approve this action and every remaining action of the same
  group. Questions the tutor asks you are still shown.

Read the list under **Después:** before you choose **Autorizar todas**. Commands run with your
own permissions on your computer.

## The token line (`/usage`)

Type `/usage` (or `/uso`) to show or hide a line at the bottom right, under the message box:

```text
↑2.4k ↓21 0.9%/262k
```

- `↑` is the text sent to the model during this session, in tokens.
- `↓` is the text the model wrote back during this session.
- The percentage shows how much of the model's capacity the latest request used, out of the
  total after the slash. It appears only when your teacher's server reports that capacity.

Marea remembers whether you leave the line on. The counts are kept when you close Marea and
resume the same session. The line never shows costs or class limits.

## When Marea shows an error

Marea retries a failed step on its own up to two times before it shows you anything. If it
still shows an error:

1. Type `/retry` to continue the same turn from where it stopped. Your message is not repeated.
2. If the error comes back, tell your teacher the time it happened. The teacher already has the
   technical detail in the dashboard, so you do not need to copy it.

`/details` shows that technical detail on your screen, together with the path of a local copy
kept on your computer. You only need it if your teacher asks for it.
