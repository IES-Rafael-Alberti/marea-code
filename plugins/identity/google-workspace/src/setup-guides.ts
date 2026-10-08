import type { ProviderSettingsDescriptor } from "@marea/plugin-api";
const text = (es: string, en: string, eu: string) => ({ es, en, eu });
export const googleSetupGuides: NonNullable<ProviderSettingsDescriptor["guides"]> = [
  {
    id: "sign-in",
    title: text(
      "Cómo configurar el acceso con Google",
      "Set up Google sign-in",
      "Konfiguratu Google bidezko sarbidea",
    ),
    steps: [
      {
        text: text(
          "En Google Cloud, crea un proyecto del centro y configura el consentimiento OAuth para usuarios internos, con openid, email y profile.",
          "In Google Cloud, create a school project and configure OAuth consent for internal users with openid, email and profile.",
          "Google Cloud-en, sortu ikastetxeko proiektua eta konfiguratu OAuth baimena barne-erabiltzaileentzat: openid, email eta profile.",
        ),
        href: "https://console.cloud.google.com/",
      },
      {
        text: text(
          "Crea un cliente OAuth de tipo Aplicación de escritorio. Copia su ID y su secreto en estos campos, junto al dominio del centro.",
          "Create a Desktop app OAuth client. Copy its ID and secret into these fields, together with the school domain.",
          "Sortu mahaigaineko aplikazio motako OAuth bezeroa. Kopiatu IDa eta sekretua eremu hauetan, ikastetxeko domeinuarekin batera.",
        ),
        href: "https://developers.google.com/workspace/guides/create-credentials",
      },
      {
        text: text(
          "En Google Admin → Seguridad → Controles de API, autoriza el ID de cliente como aplicación de confianza para el alumnado.",
          "In Google Admin → Security → API controls, authorize the client ID as a trusted app for students.",
          "Google Admin → Segurtasuna → API kontrolak atalean, baimendu bezero IDa ikasleentzako aplikazio fidagarri gisa.",
        ),
        href: "https://admin.google.com/",
      },
      {
        text: text(
          "Guardar valida los campos. La autorización de Google se comprueba al iniciar sesión. Después añade correos en Esta clase → Acceso del alumnado.",
          "Saving validates the fields. Google authorization is checked at sign-in. Then add addresses in This class → Student access.",
          "Gordetzeak eremuak balioztatzen ditu. Googleren baimena saioa hastean egiaztatzen da. Gero gehitu helbideak klasearen sarbide-ezarpenetan.",
        ),
      },
    ],
  },
  {
    id: "groups",
    fields: ["serviceAccountEmail", "serviceAccountKey", "adminEmail"],
    title: text("Cómo habilitar los grupos", "Enable group access", "Gaitu taldeen sarbidea"),
    steps: [
      {
        text: text(
          "En Google Cloud, habilita Admin SDK API y crea una cuenta de servicio con una clave JSON. Copia client_email y private_key en los campos de grupos.",
          "In Google Cloud, enable Admin SDK API and create a service account with a JSON key. Copy client_email and private_key into the group fields.",
          "Google Cloud-en, gaitu Admin SDK API eta sortu zerbitzu-kontua JSON gakoarekin. Kopiatu client_email eta private_key taldeen eremuetan.",
        ),
        href: "https://console.cloud.google.com/",
      },
      {
        text: text(
          "En Google Admin → Controles de API → Delegación en todo el dominio, añade el ID numérico de la cuenta de servicio y autoriza este ámbito:",
          "In Google Admin → API controls → Domain-wide delegation, add the service account's numeric client ID and authorize this scope:",
          "Google Admin → API kontrolak → Domeinu osoko eskuordetzea atalean, gehitu zerbitzu-kontuaren zenbakizko IDa eta baimendu eremu hau:",
        ),
        href: "https://developers.google.com/identity/protocols/oauth2/service-account#delegatingauthority",
      },
      {
        text: text(
          "https://www.googleapis.com/auth/admin.directory.group.member.readonly",
          "https://www.googleapis.com/auth/admin.directory.group.member.readonly",
          "https://www.googleapis.com/auth/admin.directory.group.member.readonly",
        ),
      },
      {
        text: text(
          "Indica un administrador del dominio con acceso a los grupos. Guarda y reinicia Marea. La pertenencia real se comprueba al acceder con un alumno del grupo.",
          "Enter a domain administrator with group access. Save and restart Marea. Actual membership is checked when a group member signs in.",
          "Adierazi taldeetarako sarbidea duen domeinuko administratzailea. Gorde eta berrabiarazi Marea. Benetako kidetza taldeko ikaslea sartzean egiaztatzen da.",
        ),
      },
    ],
  },
];
