# AmazonImageBackup

A tool to sync image files to Amazon Drive.

Currently Amazon does not accept new apps to use their API, so we have to "use" a foreign Client Secret. One example is https://drivesink.appspot.com.

Why do we need another program for that?
* At first I did not understand what drivesink does. It probably does everything you need.
* I wanted to try myself (but Amazon wouldn't let me)
* I like haveing node.js scripts better than python scripts, because I understand them better
* I'll extend my script to improve my FireTV screensaver (or build a new one based upon this one).
* Feel free to use the code in whatever way you like. Learn something, copy it into your project. I learned quite a lot (especially the few line md5 function without ~900 dependencies, like some npm packages have)

# Usage
You need to create the auth.json:
* Go to https://drivesink.appspot.com/config
* Log in to your Amazon account and grant it access
* The page will show you a grey box labeled "Here is your configuration", copy all the contents of that box.
* store it in a text file called "auth.json" in the path of this node script.

Then you should adjust config.json to your likings. Parameters are:

| Name | Description |
| :------- | ----------- |
| refreshProxyUrl | Some proxy we can use to disguise us as an already whitelisted app. Currently "https://drivesink.appspot.com/refresh" works. Leave as is. |
| debugging | Should probably be "false" for most use cases. Change to "true" if you want to see something happening. |
| accessTokenPath | Will store access token in that path. Token is good for one hour. |
| targetPath | The path on your Amazon drive to store the pictures too. Path will be created. |
| sourcePath | Path on your system to read the images from. |
| writeHashes | If set to "true" will write a NAME.EXT.MD5 file for each file processed to store the md5 hash. Will process difference checking later. Hash will be recalculated if md5 file is older than last change on image file. |
| extensionWithMime | Will only include files with an extension that matches one of the strings. Add extensions if you miss something. If you don't know the mime-type, just use "jpeg". Seems the server does not care too much. |
| silent | If set to "true" no output will happen. Will overwrite debugging setting. |

Then run `node index.js`

# License
MIT
