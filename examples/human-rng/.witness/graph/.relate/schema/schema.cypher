CREATE FULLTEXT INDEX `question_text` FOR (n:`Question`) ON EACH [n.`text`, n.`rule`, n.`probe`] OPTIONS {indexConfig: {`fulltext.analyzer`: 'standard-no-stop-words',`fulltext.eventually_consistent`: false}};
CREATE FULLTEXT INDEX `run_reason` FOR (n:`Run`) ON EACH [n.`reason`] OPTIONS {indexConfig: {`fulltext.analyzer`: 'standard-no-stop-words',`fulltext.eventually_consistent`: false}};
CREATE CONSTRAINT `file_id` FOR (n:`File`) REQUIRE (n.`id`) IS UNIQUE;
CREATE CONSTRAINT `goal_id` FOR (n:`Goal`) REQUIRE (n.`id`) IS UNIQUE;
CREATE CONSTRAINT `question_id` FOR (n:`Question`) REQUIRE (n.`id`) IS UNIQUE;
CREATE CONSTRAINT `run_id` FOR (n:`Run`) REQUIRE (n.`id`) IS UNIQUE;
