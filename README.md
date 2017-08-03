# AmazonImageSync

A tool to sync image files to Amazon Drive.

Currently Amazon does not accept new apps to use their API, so we have to "use" a foreign Client Secret. One example is https://drivesink.appspot.com.
This needs an auth.json, which you can generate using https://drivesink.appspot.com/config and then copy the stuff in the grey "Here is your configuration" field and store it in
"auth.json" in the path of this node script.

# Usage
You need to create the auth.json, like described above.
Then you should adjust config.json to your likings. Parameters are:

| Name | Description |
| ---- | ----------- |
| refreshProxyUrl | Some proxy we can use to disguise us as an already whitelisted app. Currently "https://drivesink.appspot.com/refresh" works. Leave as is. |
| debugging | Should probably be "false" for most use cases. Change to "true" if you want to see something happening. |
| accessTokenPath | Will store access token in that path. Token is good for one hour. |
| targetPath | The path on your Amazon drive to store the pictures too. Path will be created. |
| sourcePath | Path on your system to read the images from. |
| writeHashes | If set to "true" will write a NAME.EXT.MD5 file for each file processed to store the md5 hash. Will process difference checking later. Hash will be recalculated if md5 file is older than last change on image file. |
| extensions | Will only include files with an extension that matches one of the strings. Add extensions if you miss something. |

# License
MIT
