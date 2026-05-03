import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
  .field(
    "folderName", // Key of the configuration field
    "string", // Type of the configuration field
    {
      displayName: "Base Directory",
      subtitle: "The directory path where files will be stored.",
      placeholder: "/path/to/directory",
      isParagraph: false,
    },
    ``, // Default value (empty, user must set)
  )
  .build();

