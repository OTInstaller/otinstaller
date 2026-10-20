#!/usr/bin/env python3
"""Reads a public Instagram profile with Instaloader and prints it as OTInstaller entities. No login, nothing saved."""
import json
import sys

import instaloader


def main():
    if len(sys.argv) != 2:
        print("usage: instaloader-profile <username>", file=sys.stderr)
        return 2
    loader = instaloader.Instaloader(quiet=True, download_pictures=False, download_videos=False,
                                     download_comments=False, save_metadata=False, compress_json=False)
    try:
        profile = instaloader.Profile.from_username(loader.context, sys.argv[1].lstrip("@"))
    except instaloader.exceptions.ProfileNotExistsException:
        json.dump({"entities": []}, sys.stdout)
        return 0
    except instaloader.exceptions.InstaloaderException as exc:
        print(f"Instagram refused the request: {exc}", file=sys.stderr)
        return 1
    url = f"https://www.instagram.com/{profile.username}/"
    attrs = {"full_name": profile.full_name, "biography": profile.biography, "external_url": profile.external_url,
             "followers": profile.followers, "following": profile.followees, "posts": profile.mediacount,
             "is_private": profile.is_private, "is_verified": profile.is_verified, "is_business": profile.is_business_account,
             "business_category": profile.business_category_name, "user_id": profile.userid,
             "profile_pic_url": profile.profile_pic_url}
    entities = [{"type": "account", "value": url, "source": "instagram", "confidence": "high",
                 "attrs": {k: v for k, v in attrs.items() if v not in (None, "")}}]
    if profile.external_url:
        entities.append({"type": "url", "value": profile.external_url, "source": "instagram", "confidence": "high",
                         "attrs": {"relation": "profile link"}})
    if not profile.is_private:
        for i, post in enumerate(profile.get_posts()):
            if i >= 12:
                break
            entities.append({"type": "url", "value": f"https://www.instagram.com/p/{post.shortcode}/", "source": "instagram",
                             "confidence": "high", "attrs": {"relation": "post", "date_utc": post.date_utc.isoformat(),
                                                             "caption": (post.caption or "")[:500], "likes": post.likes,
                                                             "location": post.location.name if post.location else None}})
    json.dump({"entities": entities}, sys.stdout, default=str)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
