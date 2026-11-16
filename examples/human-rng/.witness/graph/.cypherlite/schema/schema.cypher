CREATE CONSTRAINT `file_id` FOR (n:`File`) REQUIRE (n.`id`) IS UNIQUE;
CREATE CONSTRAINT `goal_id` FOR (n:`Goal`) REQUIRE (n.`id`) IS UNIQUE;
CREATE CONSTRAINT `question_id` FOR (n:`Question`) REQUIRE (n.`id`) IS UNIQUE;
CREATE CONSTRAINT `run_id` FOR (n:`Run`) REQUIRE (n.`id`) IS UNIQUE;
