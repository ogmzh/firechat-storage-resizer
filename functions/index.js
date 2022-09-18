const functions = require("firebase-functions");
const mkdirp = require("mkdirp");
const admin = require("firebase-admin");
const spawn = require("child-process-promise").spawn;
const path = require("path");
const os = require("os");
const fs = require("fs");

admin.initializeApp();

const MAX_WIDTH = 250;
const THUMB_MAX_HEIGHT = 200;
const THUMB_MAX_WIDTH = 200;
const THUMB_PREFIX = "thumb_";
const runtimeOpts = {
  timeoutSeconds: 60,
  memory: "256MB",
};

// possible permission issues between firebase and google cloud
// https://stackoverflow.com/questions/69288690/firebase-admin-storage-the-caller-does-not-have-permission
// https://stackoverflow.com/a/48457377/7478712
// also, add firestore admin role to the {appname}@appspot.gserviceaccount.com user on
// console.cloud.google.com/iam-admin

/* 
    - User uploads an image through the app
    - Image ends up in /files/${user?.uid}/assets/upload/${file.name}
    - This function picks up the file, scales it down to 1080p max
    - Uploads the scaled down version to /files/${user?.uid}/assets/images/${file.name}
    - Generates a publicly available signed URL
    - Deletes the original file
*/
exports.imageToJPG = functions
  .runWith(runtimeOpts)
  .storage.object()
  .onFinalize(async (object) => {
    const filePath = object.name || "";
    functions.logger.log("Loaded file:", filePath);

    // functions.logger.log("OBJECT META:", object.metadata);
    // functions.logger.log(
    //   "Metadata messageOrigin:",
    //   object.metadata.messageOrigin
    // );

    const baseFileName = path.basename(filePath);
    const fileDir = path.dirname(`${filePath}`);
    // Exit if this is triggered on a file that is not in the uploads subdirectory
    if (!fileDir.endsWith("/upload")) {
      functions.logger.info("skip running for scaled images");
      return null;
    }
    functions.logger.log("OBJECT never notice:", object);
    functions.logger.log("OBJECT never notice:", object.metadata);

    const scaledFilePath = path.normalize(
      path.join(fileDir, `scaled_${baseFileName}`)
    );
    const tempLocalFile = path.join(os.tmpdir(), filePath);
    const tempLocalDir = path.dirname(tempLocalFile);
    const tempLocalScaledFile = path.join(os.tmpdir(), scaledFilePath);
    functions.logger.log("Destination file path:", tempLocalScaledFile);

    // Exit if this is triggered on a file that is not an image.
    if (!object.contentType?.startsWith("image/")) {
      functions.logger.warn("This is not an image.");
      return null;
    }

    const bucket = admin.storage().bucket(object.bucket);
    // Create the temp directory where the storage file will be downloaded.
    await mkdirp(tempLocalDir);
    // Download file from bucket.
    await bucket.file(filePath).download({ destination: tempLocalFile });
    functions.logger.info("The file has been downloaded to", tempLocalFile);
    await spawn("convert", [tempLocalFile, tempLocalScaledFile]);
    functions.logger.log("Scaled created at", tempLocalScaledFile);
    const bucketFilePath = scaledFilePath.replace("upload/", "images/");
    const response = await bucket.upload(tempLocalScaledFile, {
      destination: bucketFilePath,
    });
    functions.logger.info("Scaled upload to storage:", bucketFilePath);

    const signedImageUrlArr = await response[0].getSignedUrl({
      action: "read",
      expires: "01-01-2222",
    });
    const signedImageUrl = signedImageUrlArr[0];
    functions.logger.info("Generated signed url:", signedImageUrl);

    // Once the image has been converted delete the
    // local files to free up disk space.
    fs.unlinkSync(tempLocalScaledFile);
    fs.unlinkSync(tempLocalFile);

    // delete the original asset/upload file
    await bucket.file(filePath).delete();
    functions.logger.info("Deleted the asset upload.");
    await admin.firestore().doc(object.metadata.messageOrigin).update({
      resource: signedImageUrl,
    });
    functions.logger.info("Updated the firestore origin message. Finishing.");
    return { originalMetadata: { ...object.metadata }, url: signedImageUrl };
  });
