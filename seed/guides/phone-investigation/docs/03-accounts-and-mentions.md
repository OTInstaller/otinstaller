# Accounts and mentions

## Accounts registered with the number

```
ot run osintverse-community/ignorant --country_code 1 --phone 2025550123
```

ignorant checks whether the number is linked to accounts on Amazon, Instagram and Snapchat, using their sign-up and
recovery checks in a way that does not notify the owner. It needs the country code and the national number
separately, which you have from [parsing](02-parse.md).

## Where the number appears

phoneinfoga's scan output includes ready-made search queries for the number in all its formats: social networks,
classified ads, reputation sites (spam and scam reports) and documents. Run them by hand in your browser and note
what you open.

- **Business listings** and **classified ads** often show the name of the person or company behind a number.
- **Spam reports** tell you if the number is used for robocalls or scams, which is common for numbers in fraud cases.
- **Messaging apps** show a profile photo and name for many numbers, but only after you save the number as a
  contact on your own phone. That is an active step with its own privacy implications; decide it within your
  [scope](01-scope-and-legal.md).

## Pivot

Names, usernames and emails found here go to the
[username](https://otinstaller.com/guides/osintverse-community/username-investigation) and
[email](https://otinstaller.com/guides/osintverse-community/email-investigation) playbooks.
