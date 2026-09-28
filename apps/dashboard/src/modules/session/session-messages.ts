import type { Locale } from "@marea/i18n";

export function sessionMessages(locale: Locale) {
  return locale === "en"
    ? {
        heading: "Sign in",
        intro: "Sign in with the teacher account your administrator created for you.",
        checking: "Checking your session…",
        login: "Username",
        password: "Password",
        submit: "Sign in",
        submitting: "Signing in…",
        signedInAs: (name: string) => `Signed in as ${name}`,
        signOut: "Sign out",
        signingOut: "Signing out…",
        problems: {
          invalid: "The username or password is not correct.",
          "not-teacher": "This dashboard is for teachers. Students use the marea application.",
          unavailable: "The teacher server could not be reached. Try again in a moment.",
        },
      }
    : locale === "eu"
      ? {
          heading: "Hasi saioa",
          intro: "Hasi saioa administrazioak sortutako irakasle-kontuarekin.",
          checking: "Zure saioa egiaztatzen…",
          login: "Erabiltzailea",
          password: "Pasahitza",
          submit: "Hasi saioa",
          submitting: "Saioa hasten…",
          signedInAs: (name: string) => `${name} gisa saioa hasita`,
          signOut: "Itxi saioa",
          signingOut: "Saioa ixten…",
          problems: {
            invalid: "Erabiltzailea edo pasahitza ez da zuzena.",
            "not-teacher":
              "Panel hau irakasleentzat da. Ikasleek marea aplikazioa erabiltzen dute.",
            unavailable:
              "Ezin izan da irakaslearen zerbitzariarekin konektatu. Saiatu berriro une batean.",
          },
        }
      : {
          heading: "Iniciar sesión",
          intro: "Inicia sesión con la cuenta de docente que te ha creado la administración.",
          checking: "Comprobando tu sesión…",
          login: "Usuario",
          password: "Contraseña",
          submit: "Iniciar sesión",
          submitting: "Iniciando sesión…",
          signedInAs: (name: string) => `Sesión iniciada como ${name}`,
          signOut: "Cerrar sesión",
          signingOut: "Cerrando sesión…",
          problems: {
            invalid: "El usuario o la contraseña no son correctos.",
            "not-teacher": "Este panel es para docentes. El alumnado usa la aplicación marea.",
            unavailable:
              "No se ha podido contactar con el servidor docente. Inténtalo de nuevo en un momento.",
          },
        };
}
