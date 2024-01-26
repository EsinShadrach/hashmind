import { inngest } from "@api/config/inngest_client";
import generateImage from "../../functions/generateCoverImage";
import prisma from "@/prisma/prisma";
import HttpException from "../../utils/exception";
import { AUTHOR_NAMES, GPT_RESP_STYLE_NAME, RESPONSE_CODE } from "@/types";
import generateArticleContent from "../../functions/generateArticleContent";
import hashnodeService, {
  PublishedArtRespData,
} from "../../services/hashnode.service";
import { nanoid } from "nanoid";

// Main function
export const inngest_hashmind_main_function = inngest.createFunction(
  {
    id: "hashmind-main-function",
  },
  { event: "hashmind/main" },
  async ({ event, step }) => {
    // invoke article coverimage generation function
    await step.invoke("hashmind/article-coverimage.creation", {
      function: inngest_article_coverimage_generation_function,
      data: {
        subtitle: event.data.subtitle,
        keywords: event.data.keywords,
        userId: event.data.userId,
        title: event.data.title,
        jobId: event.data.jobId,
      },
    });

    return {};
  }
);

// ARTICLE GENERATION FUNCTIONS

// cover image
export const inngest_article_coverimage_generation_function =
  inngest.createFunction(
    {
      id: "hashmind-article-coverimage-creation",
      onFailure: async ({ error, event, step }) => {
        console.log(`❌ COVER IMAGE GENERATION FAILED`, error);
        // update queue in db
        const jobData = event.data.event.data;
        const jobId = jobData.jobId;
        const userId = jobData.userId;
        const mainJob = await prisma.queues.findFirst({
          where: {
            id: jobId,
            userId: userId,
          },
          include: { subqueue: true },
        });

        if (!mainJob) {
          throw new HttpException(
            RESPONSE_CODE.ERROR_UPDATING_QUEUE,
            `Error updating queue,for failed Job with [id: ${jobId}] not found`,
            404
          );
        }

        const subqueue = mainJob.subqueue.find(
          (subqueue) => subqueue.identifier === "cover-image"
        );

        await prisma.queues.update({
          where: {
            id: jobId,
            userId: jobId,
          },
          data: {
            subqueue: {
              update: {
                where: {
                  id: subqueue?.id,
                  identifier: "cover-image",
                },
                data: {
                  status: "failed",
                  message: "Cover image generation failed",
                },
              },
            },
          },
        });
      },
    },
    { event: "hashmind/article-coverimage.creation" },
    async ({ event, step }) => {
      await step.sleep("wait-a-moment", "1s");

      const coverImage = await generateImage.genCoverImageStAI({
        subtitle: event.data.subtitle as string,
        keywords: event.data.keywords as string,
      });
      const coverImageUrl = coverImage.url;

      // update the queue in db
      const jobId = event.data.jobId;
      const mainJob = await prisma.queues.findFirst({
        where: {
          id: jobId,
          userId: event.data.userId,
        },
        include: { subqueue: true },
      });

      if (!mainJob) {
        throw new HttpException(
          RESPONSE_CODE.ERROR_UPDATING_QUEUE,
          `Error updating queue, Job with [id: ${jobId}] not found`,
          404
        );
      }

      const subqueue = mainJob.subqueue.find(
        (subqueue) => subqueue.identifier === "cover-image"
      );

      await prisma.queues.update({
        where: {
          id: jobId,
          userId: event.data.userId,
        },
        data: {
          subqueue: {
            update: {
              where: {
                id: subqueue?.id,
                identifier: "cover-image",
              },
              data: {
                status: "completed",
                message: "Cover image generated",
              },
            },
          },
        },
      });

      console.log(`✅ COVER IMAGE GENERATED`);

      // invoke content creation function
      await step.invoke("hashmind/article-content.creation", {
        function: inngest_article_content_generation_function,
        data: {
          title: event.data.title,
          userId: event.data.userId,
          coverImage: coverImageUrl,
          jobId: event.data.jobId,
          subtitle: event.data.subtitle,
        },
      });

      return { coverImageUrl };
    }
  );

// article content
export const inngest_article_content_generation_function =
  inngest.createFunction(
    {
      id: "hashmind-article-content-creation",
    },
    { event: "hashmind/article-content.creation" },
    async ({ event, step }) => {
      console.log("CREATING ARTICLE CONTENT TRIGGERED", event.name);

      const defaultUserStyle = await prisma.settings.findFirst({
        where: {
          userId: event.data.userId,
        },
      });

      const response = await generateArticleContent({
        title: event.data.title as string,
        subtitle: event.data.subtitle as string,
        chatHistory: "",
        context: "",
        userReq: {
          style: defaultUserStyle?.gpt_style as GPT_RESP_STYLE_NAME,
          author: (defaultUserStyle?.default_author_name as AUTHOR_NAMES) ?? "",
        },
      });

      // update the queue in db
      const jobId = event.data.jobId;
      const mainJob = await prisma.queues.findFirst({
        where: {
          id: jobId,
          userId: event.data.userId,
        },
        include: { subqueue: true },
      });

      if (!mainJob) {
        throw new HttpException(
          RESPONSE_CODE.ERROR_UPDATING_QUEUE,
          `Error updating queue, Job with [id: ${jobId}] not found`,
          404
        );
      }

      const subqueue = mainJob.subqueue.find(
        (subqueue) => subqueue.identifier === "article-content"
      );

      await prisma.queues.update({
        where: {
          id: jobId,
          userId: event.data.userId,
        },
        data: {
          subqueue: {
            update: {
              where: {
                id: subqueue?.id,
                identifier: "article-content",
              },
              data: {
                status: "completed",
                message: "Article content generated",
              },
            },
          },
        },
      });

      console.log(`✅ ARTICLE CONTENT GENERATED`);

      // invoke function for publishing article
      await step.invoke("hashmind/article.publish", {
        function: inngest_publish_article_function,
        data: {
          title: event.data.title,
          userId: event.data.userId,
          coverImage: event.data.coverImage,
          content: response.content as string,
          jobId: event.data.jobId,
          subtitle: event.data.subtitle,
        },
      });

      return {};
    }
  );

// metadata
export const inngest_article_metadata_creation_function =
  inngest.createFunction(
    {
      id: "hashmind-article-metadata-creation",
    },
    { event: "hashmind/article-metadata.creation" },
    async ({ event, step }) => {
      console.log("CREATING ARTICLE METADATA", event);
      return {};
    }
  );

// ARTICLE UPDATE FUNCTIONS

// PUBLISHING ARTICLE

// publish article to hashnode
export const inngest_publish_article_function = inngest.createFunction(
  { id: "hashmind-article-publishing" },
  { event: "hashmind/article.publish" },
  async ({ event, step }) => {
    console.log(`PUBLISHING ARTICLE EVENT FIRED`, event.name);

    const userId = event.data.userId;
    const content = event.data.content ?? "";
    const coverImage = event.data.coverImage ?? "";
    const emoji = event.data.emoji ?? "🚀";
    const subtitle = event.data.subtitle ?? "";
    const title = event.data.title ?? "";
    const jobId = event.data.jobId;
    const hashnodeTagId = "567ae5a72b926c3063c3061a";
    const slug = (subtitle as string).toLowerCase().replace(/\s/g, "-");

    const user = await prisma.users.findFirst({
      where: {
        userId,
      },
      include: { settings: true },
    });

    if (!user) {
      throw new HttpException(
        RESPONSE_CODE.ERROR_PUBLISHING_ARTICLE,
        `Error publishing article, User with [id: ${userId}] not found`,
        404
      );
    }

    console.log(`⏳ PUBLISHING ARTICLE TO HASHNODE`);
    const publishArticle = await hashnodeService.createPost({
      title: title as string,
      subtitle: subtitle as string,
      contentMarkdown: content as string,
      slug,
      apiKey: user?.settings?.hashnode_token as string,
      publicationId: user?.settings?.hashnode_pub_id as string,
      coverImageOptions: {
        coverImageURL: coverImage as string,
      },
      metaTags: {
        title: title as string,
        description: subtitle as string,
        image: coverImage as string,
      },
      tags: [{ id: hashnodeTagId }],
    });

    if (publishArticle.error) {
      console.log(`❌ ERROR PUBLISHING ARTICLE TO HASHNODE`, publishArticle);
      throw new HttpException(
        RESPONSE_CODE.ERROR_PUBLISHING_ARTICLE,
        `Error publishing article, ${publishArticle.error}`,
        500
      );
    }

    const pubArticle = publishArticle.data as PublishedArtRespData;
    const artUrl = pubArticle.url;
    const artId = pubArticle.id;

    // set main job status as completed
    const mainJob = await prisma.queues.findFirst({
      where: {
        id: jobId,
        userId: event.data.userId,
      },
      include: { subqueue: true },
    });

    if (!mainJob) {
      throw new HttpException(
        RESPONSE_CODE.ERROR_UPDATING_QUEUE,
        `Error updating queue, Job with [id: ${jobId}] not found`,
        404
      );
    }

    await prisma.queues.update({
      where: {
        id: jobId,
        userId: event.data.userId,
      },
      data: {
        status: "completed",
      },
    });

    // store content in db
    await prisma.contentMetaData.create({
      data: {
        id: nanoid(),
        emoji,
        link: artUrl,
        title,
        sub_heading: subtitle,
        article_id: artId,
        user: {
          connect: {
            userId,
          },
        },
      },
    });

    console.log(`✅ ARTICLE PUBLISHED TO HASHNODE`);

    return {};
  }
);
