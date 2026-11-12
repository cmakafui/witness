CREATE CONSTRAINT `answer_id` FOR (n:`Answer`) REQUIRE (n.`id`) IS UNIQUE;
CREATE CONSTRAINT `file_id` FOR (n:`File`) REQUIRE (n.`id`) IS UNIQUE;
CREATE CONSTRAINT `package_id` FOR (n:`Package`) REQUIRE (n.`id`) IS UNIQUE;
CREATE CONSTRAINT `question_id` FOR (n:`Question`) REQUIRE (n.`id`) IS UNIQUE;
CREATE CONSTRAINT `run_id` FOR (n:`Run`) REQUIRE (n.`id`) IS UNIQUE;
