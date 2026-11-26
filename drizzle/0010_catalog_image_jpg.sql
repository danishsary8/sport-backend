-- The storefront publishes every catalogue photo as catalog/<name>.jpg; earlier imports kept a .png name.
UPDATE "product_images" SET "path" = regexp_replace("path", '\.png$', '.jpg') WHERE "path" LIKE 'catalog/%.png';
