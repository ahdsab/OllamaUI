import { GetBucketLocationCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

let s3Client = new S3Client({
  region: process.env.AWS_REGION,
  endpoint: process.env.AWS_S3_ENDPOINT || undefined,
  forcePathStyle: Boolean(process.env.AWS_S3_ENDPOINT),
});

function getBufferAndMimeFromBase64(base64DataUrl: string): { buffer: Buffer; mimeType: string } {
  const matches = base64DataUrl.match(/^data:(.*?);base64,(.*)$/);
  if (!matches || matches.length !== 3) {
    throw new Error("Invalid base64 data URL");
  }
  const mimeType = matches[1];
  const data = matches[2];
  const buffer = Buffer.from(data, "base64");
  return { buffer, mimeType };
}

export async function uploadBase64ImageToS3(params: {
  base64Image: string;
  keyPrefix?: string;
  bucket?: string;
}): Promise<{ key: string; url: string }> {
  const { base64Image, keyPrefix = "uploads/", bucket = process.env.BUCKET_NAME! } = params;

  if (!bucket) {
    throw new Error("BUCKET_NAME is not configured");
  }
  if (!process.env.AWS_REGION) {
    throw new Error("AWS_REGION is not configured");
  }

  const { buffer, mimeType } = getBufferAndMimeFromBase64(base64Image);

  const extension = mimeType.split("/")[1] || "jpg";
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const key = `${keyPrefix}${unique}.${extension}`;

  // Ensure we are using the correct bucket region to avoid endpoint mismatches
  let resolvedRegion: string = process.env.AWS_REGION!;
  try {
    const loc = await s3Client.send(new GetBucketLocationCommand({ Bucket: bucket }));
    // us-east-1 returns null/"" location constraint
    const bucketRegion = !loc.LocationConstraint || loc.LocationConstraint === "" ? "us-east-1" : String(loc.LocationConstraint);
    resolvedRegion = bucketRegion;
    if (bucketRegion && bucketRegion !== process.env.AWS_REGION) {
      s3Client = new S3Client({
        region: bucketRegion,
        endpoint: process.env.AWS_S3_ENDPOINT || undefined,
        forcePathStyle: Boolean(process.env.AWS_S3_ENDPOINT),
      });
    }
  } catch (e) {
    // If we cannot get location, proceed with current client; upload may still succeed
  }

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
    ACL: "public-read",
  });

  try {
    await s3Client.send(command);
  } catch (err) {
    console.error("S3 upload failed:", err);
    throw err;
  }

  // Prefer explicitly configured public URL base if provided (useful for VPC endpoints or S3-compatible stores)
  const publicBase = process.env.AWS_S3_PUBLIC_URL
    ? process.env.AWS_S3_PUBLIC_URL.replace(/\/$/, "")
    : process.env.AWS_S3_ENDPOINT
    ? process.env.AWS_S3_ENDPOINT.replace(/\/$/, "")
    : `https://${bucket}.s3.${resolvedRegion}.amazonaws.com`;

  const url = `${publicBase}${publicBase.includes(bucket) ? "" : `/${bucket}`}/${key}`;
  return { key, url };
}


